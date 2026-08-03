# Feature: Send comms copy to Google Chat, in-app

## Feature Description
On a Comms Schedule row's day-panel card (the calendar view's card that already
shows the message copy in a "COPY" box, per the attached screenshot), add a
**Send** button next to the existing **Copy** button. Tapping it opens a small
picker of configured Google Chat channels (spaces); picking one posts that
row's saved copy straight to that space via a Google Chat Incoming Webhook,
and — on success — flips the row's status to **Sent** automatically. No more
copy-to-clipboard-then-paste-into-Google-Chat round trip for reminder sends.

## User Story
As a Comms Lead
I want to send a comms row's copy to a Google Chat space with one click, picking the channel right there on the card
So that reminder sends (T-7 / T-3 / T-1, day-of, thank-yous) go out faster and the row's status reflects reality without a second manual step

## Problem Statement
The Comms Schedule already captures the exact message text per row (`fields.notes`,
shown in the card's "COPY" box) and already renders a channel LABEL per row
(the `channel` multiselect — `google_chat`, `imessage_group`, `ig_post`, …,
badges at the left of the card, per `config.ts#CHANNEL_ICON`). But that
`channel` field is descriptive metadata only — a tag saying "this goes out on
Google Chat" — not a live send mechanism. Actually delivering the message
still means: tap Copy, switch to Google Chat, pick the space, paste, send,
come back and manually flip Status to Sent. For a cadence that repeats at
T-7/T-3/T-1 (`docs/guides/owning-the-comms-area.md`), that's real friction the
Comms Lead pays every single time.

## Solution Statement
Add a real, in-app send path for exactly one channel — Google Chat, the one
the org actually uses (per #479's Slack→Google Chat rename) — following the
same "mutation validates + schedules an internal action that does the network
call, then a mutation finalizes the row" shape `blasts.ts#sendBlast` /
`deliverBlast` / `finishBlast` already establishes for outbound sends in this
codebase, and the same write-only-secret discipline
`integrationSettings.ts` uses for Twilio/Resend/Givebutter credentials
(a Google Chat Incoming Webhook URL carries its auth in the URL itself, so it
is treated exactly like those secrets: settable by a superuser, never
readable back).

Google Chat **channels** (named spaces, each with its own webhook URL) are a
new small admin-managed list — `googleChatChannels` — deployment-wide, not
per-chapter, mirroring how Twilio/Resend/Givebutter credentials are ALSO one
shared deployment-wide setting today (`schema/integrationSettings.ts`'s
module doc: "the deployment-wide singleton"). This app is one Google
Workspace shared across chapters, so a shared channel list matches how the
org actually uses Google Chat, and it costs nothing to widen later if that
turns out wrong.

The gate on who may fire a send follows CLAUDE.md's "gate it behind a power,
even when it's open today": a new named resolver,
`lib/commsAccess.ts#requireCommsSend`, whose body TODAY is exactly
`requireBlastSend`'s body (bare event-chapter membership) — not an inline
check at the call site — so if this ever needs to graduate to a seat
capability, it's a one-file change, per `lib/campaignsAccess.ts`'s own
documented precedent for exactly this situation.

## Scope
**In scope:**
- A `googleChatChannels` table + superuser CRUD (add/rename/replace webhook/
  archive), with the webhook URL write-only (never returned to any client).
- A public, name-only channel list any signed-in caller can read (for the
  send picker) — never the webhook URL.
- `commsSend.ts`: the mutation → scheduled action → finalize-mutation send
  flow, gated by `requireCommsSend`, restricted to `module === "comms"` rows,
  posting the row's ALREADY-SAVED copy (not an in-flight unsaved draft).
- On send success: the item's `status` is set to `"sent"` and
  `fields.lastGoogleChatSend` records `{channelId, channelName, status,
  sentAt}` (or `{..., status:"failed", error}` on failure — status is left
  untouched on failure).
- The Send button + channel picker on the comms day-panel card (calendar
  view), next to the existing Copy button, comms-module only.
- A "Google Chat" card on Profile → Integrations (superuser-only) to manage
  channels, matching the existing Twilio/Resend card styling.
- A one-line Academy wording fix (`streams/events.ts`'s `tab-comms` lesson
  still lists "Slack" in its channel-column example — stale since #479).

**Out of scope:**
- Automatic/scheduled sending on a row's due date — this ships MANUAL
  click-to-send only. Nothing about the reminder cadence becomes automatic.
- Sending from the Table view (the EditableGrid grid). The Copy button this
  mirrors is calendar-card-only today (`ItemCardText.tsx`'s `CopyEditor`); the
  Send button follows it there and nowhere else.
- Per-chapter Google Chat channels — see Solution Statement.
- Any channel other than Google Chat (email/SMS already have `blasts.ts`;
  IG/iMessage have no API this PR touches).
- A send-history list/audit table (like `blasts`' "Sent blasts" list). One
  row's most-recent send outcome (`fields.lastGoogleChatSend`) is enough for
  this PR; a full history is easy to add later if wanted.
- Seat-capability gating (`comms.send`) — deliberately deferred, per
  `requireCommsSend`'s doc; see Solution Statement.

## Relevant Files

- `apps/convex/blasts.ts` — **pattern**: the mutation-validates →
  `ctx.scheduler.runAfter` an internal action → internal action does the
  network call → internal mutation finalizes the row shape this feature
  copies wholesale for `commsSend.ts`.
- `apps/convex/lib/campaignsAccess.ts` — **pattern**: `requireBlastSend`'s doc
  is the literal template for `lib/commsAccess.ts#requireCommsSend`
  (bare-`requireEvent` today, named graduation path documented, not enforced).
- `apps/convex/integrationSettings.ts` + `apps/convex/schema/integrationSettings.ts`
  — **pattern**: write-only secret discipline (`last4`, never the raw value),
  superuser-gated set/clear, stored-setting-first resolution — the shape
  `googleChatChannels.ts` follows for the webhook URL.
- `apps/convex/lib/twilio.ts` — **pattern**: a `fetch`-based external-send
  helper in `lib/`, throwing a status+body error that never leaks the secret
  — the shape `lib/googleChat.ts#postGoogleChatMessage` follows.
- `apps/convex/items.ts` — export the existing private `mergeFields` helper
  (used by `updateEventItem`/`setStatus` etc. to merge into the `fields` bag
  without clobbering other keys) so `commsSend.ts` reuses it instead of
  reimplementing the same null-deletes-key convention.
- `apps/convex/schema/events.ts` — `eventItems` table (no schema change here;
  `fields` is already `v.optional(v.record(v.string(), v.any()))`, so
  `lastGoogleChatSend` needs no migration).
- `apps/convex/schema.ts` — register the new `googleChatChannels` table.
- `apps/mobile/app/(app)/integrations.tsx` — wire in the new Google Chat
  channels card, alongside the existing Twilio/Resend/Givebutter cards.
- `apps/mobile/components/integrations/TwilioUsageSummary.tsx` — **pattern**:
  a standalone sub-card component imported into `integrations.tsx`, kept out
  of that already-1300+-line file.
- `apps/mobile/components/event/moduleCalendar/ItemCardText.tsx` — `CopyEditor`
  gets an optional `headerExtra` slot rendered next to the existing `CopyButton`.
- `apps/mobile/components/event/moduleCalendar/ItemCard.tsx` — threads a new
  `canSendGoogleChat` boolean down to `CopyEditor`'s `headerExtra`.
- `apps/mobile/components/event/moduleCalendar/index.tsx` — computes
  `config.module === "comms"` and passes it to `ItemCard` as
  `canSendGoogleChat` (mirrors how `config.badgeField` is already threaded here).
- `apps/mobile/components/event/moduleCalendar/ItemCardStatus.tsx` —
  **pattern**: `BadgeEditor`'s `Popover` + `measureAnchor` anchoring is the
  template for the channel picker popover in `SendToGoogleChatButton.tsx`.
- `apps/mobile/components/event/ticketing/BlastComposerCard.tsx` — reference
  for the "compose → confirm → send, disable while sending, surface errors
  inline" UX shape (not copied wholesale — this feature's send is a single
  pre-written row, not a composer).
- `packages/shared/src/academy/streams/events.ts` — the `tab-comms` lesson's
  channel-column example row (`["**Channel**", "... IG, the iMessage group,
  email, Slack?"]`) still says "Slack"; fix to "Google Chat".
- `apps/convex/tests/blasts.test.ts` — **pattern**: `vi.useFakeTimers()` +
  `await t.finishAllScheduledFunctions(vi.runAllTimers)` to drain a scheduled
  internal action inside a test, with `globalThis.fetch` stubbed.
- `apps/convex/tests/integrationSettings.test.ts` — **pattern**: superuser-gate
  + "never returns the secret" test shape for `googleChatChannels.test.ts`.
- `apps/convex/tests/itemUnschedule.test.ts` — **pattern**: hand-seeding an
  `eventTypes`/`events`/`eventItems` row directly via `ctx.db.insert` inside
  `run(t, ...)`, for `commsSend.test.ts`'s fixtures.
- `apps/convex/tests/setup.helpers.ts` — `newT()` / `setupChapter()` / `run()`
  fixtures every new test file uses.

### New Files
- `apps/convex/schema/googleChatChannels.ts` — the `googleChatChannels` table.
- `apps/convex/googleChatChannels.ts` — superuser CRUD + the public name-only list.
- `apps/convex/lib/googleChat.ts` — `buildGoogleChatMessage` (pure formatter)
  + `postGoogleChatMessage` (the `fetch` call).
- `apps/convex/lib/commsAccess.ts` — `requireCommsSend`.
- `apps/convex/commsSend.ts` — `sendCommsToGoogleChat` (mutation),
  `deliverCommsSend` (internal action), `finishCommsSend` (internal mutation),
  `loadSendContext` (internal query).
- `apps/convex/tests/googleChat.test.ts` — unit tests for `lib/googleChat.ts`.
- `apps/convex/tests/googleChatChannels.test.ts` — CRUD + secret-discipline tests.
- `apps/convex/tests/commsSend.test.ts` — the send flow's characterization tests.
- `apps/mobile/components/integrations/GoogleChatChannelsCard.tsx` — the
  superuser channel-management card.
- `apps/mobile/components/event/moduleCalendar/SendToGoogleChatButton.tsx` —
  the card's Send button + channel popover + inline last-send status.

## Implementation Plan

### Phase 1: Foundation
- `schema/googleChatChannels.ts`: the table.
- `lib/googleChat.ts`: pure message formatter + the webhook POST helper —
  zero dependencies on the rest of the feature, fully unit-testable first.
- `lib/commsAccess.ts`: the named access gate.
- `items.ts`: export `mergeFields`.

### Phase 2: Core Implementation
- `googleChatChannels.ts`: superuser CRUD + public list.
- `commsSend.ts`: the full send flow (mutation → scheduled action → finalize).

### Phase 3: Integration
- Register the new table in `schema.ts`.
- Wire `GoogleChatChannelsCard` into `integrations.tsx`.
- Wire `SendToGoogleChatButton` into `CopyEditor` → `ItemCard` → `index.tsx`.
- Academy wording fix.

## Step by Step Tasks

### 1. Google Chat message + send helpers (`lib/googleChat.ts`)

**a. Write the failing test (RED).** Create `apps/convex/tests/googleChat.test.ts`.
It imports `buildGoogleChatMessage` and `postGoogleChatMessage` from
`../lib/googleChat` — a module that doesn't exist yet, so the import itself
fails (genuine RED: the code doesn't exist). Cases:
- `buildGoogleChatMessage({ eventName: "Eden", itemTitle: "T-3 reminder", copy: "Hey team, be on time." })`
  returns `"*T-3 reminder* — Eden\n\nHey team, be on time."`.
- With `itemTitle: ""` (an untitled row), returns just `"Eden\n\nHey team, be on time."`
  (no dangling `"* — "`).
- `postGoogleChatMessage(url, text)`, with `globalThis.fetch` stubbed to return
  `{ ok: true }`, POSTs to exactly `url` with header
  `"Content-Type": "application/json; charset=UTF-8"` and body
  `JSON.stringify({ text })`.
- `postGoogleChatMessage` with `fetch` stubbed to return
  `{ ok: false, status: 400, text: async () => "Bad Request" }` throws an
  `Error` whose message contains `"400"` and `"Bad Request"` but does
  **NOT** contain the webhook URL (assert
  `!String(err).includes(url)` — the URL carries the space's auth token, so
  it must never land in a thrown message a non-superuser caller could see in
  a toast).

**b. Implement.** In `lib/googleChat.ts`:
```ts
export function buildGoogleChatMessage({ eventName, itemTitle, copy }: {
  eventName: string; itemTitle: string; copy: string;
}): string {
  const heading = itemTitle ? `*${itemTitle}* — ${eventName}` : eventName;
  return `${heading}\n\n${copy}`;
}

export async function postGoogleChatMessage(webhookUrl: string, text: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Google Chat send failed (${response.status}): ${await response.text()}`);
  }
}
```
Open with a block comment (per CLAUDE.md/house style) explaining this is the
ONE webhook POST per send — no `"use node"` needed, mirrors `lib/twilio.ts`'s
note that `fetch` works in the default runtime.

**c. Run the full suite** (`pnpm --filter @events-os/convex exec vitest run tests/googleChat.test.ts`, then the full backend suite) before moving on.

### 2. Google Chat channels: schema + CRUD (`googleChatChannels.ts`)

**a. Write the failing test (RED).** Create
`apps/convex/tests/googleChatChannels.test.ts`. It calls
`api.googleChatChannels.addGoogleChatChannel` — doesn't exist yet, genuine RED.
Cases (mirror `tests/integrationSettings.test.ts`'s shape):
- A non-superuser calling `addGoogleChatChannel` is rejected
  (`rejects.toBeInstanceOf(ConvexError)`); no row written.
- A superuser adds `{ name: "Leaders", webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=x&token=y" }`;
  `listGoogleChatChannels` (called by a NON-superuser `as`) returns
  `[{ _id, name: "Leaders" }]` — assert the returned object has no
  `webhookUrl` key at all (`!("webhookUrl" in result[0])`).
- `getGoogleChatChannelsStatus` (superuser) shows the channel with a
  `urlSuffix` (last 6 chars) but never the full URL and never `webhookUrl` itself.
- `addGoogleChatChannel` with a `webhookUrl` that doesn't start with
  `"https://chat.googleapis.com/"` is rejected with `ConvexError`; no row written.
- `archiveGoogleChatChannel({ channelId, archived: true })` removes it from
  `listGoogleChatChannels` but it still appears (flagged `archived: true`) in
  `getGoogleChatChannelsStatus`.
- `renameGoogleChatChannel` / `updateGoogleChatChannelWebhook` by a
  non-superuser are both rejected; the row is unchanged (assert via
  `run(t, ctx => ctx.db.get(channelId))`).

**b. Implement.**
- `schema/googleChatChannels.ts`:
  ```ts
  export const googleChatChannels = defineTable({
    name: v.string(),
    webhookUrl: v.string(), // SECRET — carries the space's auth token in the URL; write-only, same discipline as integrationSettings' keys.
    archived: v.optional(v.boolean()),
    createdBy: v.id("users"),
    updatedBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  });
  ```
  (No index needed yet — this list is small; `.collect()` on the whole table
  is fine, same as `integrationSettings`' singleton reads.)
- `googleChatChannels.ts`:
  - `last6(url)`: last 6 characters, for the status projection (mirrors
    `integrationSettings.ts#last4`).
  - `addGoogleChatChannel` (mutation, `requireSuperuser`): validates
    `name.trim()` non-empty and `webhookUrl.trim().startsWith("https://chat.googleapis.com/")`,
    inserts, stamps `createdBy`/`updatedBy`/`createdAt`/`updatedAt`.
  - `renameGoogleChatChannel` (mutation, `requireSuperuser`): `{ channelId, name }`.
  - `updateGoogleChatChannelWebhook` (mutation, `requireSuperuser`):
    `{ channelId, webhookUrl }`, same format validation as add.
  - `archiveGoogleChatChannel` (mutation, `requireSuperuser`):
    `{ channelId, archived: boolean }`.
  - `listGoogleChatChannels` (query, `requireUserId` only — any signed-in
    caller, mirrors how `previewBlastAudience` needs no special power to
    preview): returns non-archived channels as `{ _id, name }[]`, sorted by name.
  - `getGoogleChatChannelsStatus` (query, `requireSuperuser`): returns EVERY
    channel (archived included) as `{ _id, name, urlSuffix, archived, updatedAt }[]`.
  - `readGoogleChatWebhookUrl` (internalQuery): `{ channelId } → string | null`
    — the ONLY place the raw URL ever leaves the table, reachable solely from
    `commsSend.ts`'s delivery action (mirrors `readTwilioCredentials`).

**c. Run the full suite.**

### 3. Comms send flow (`lib/commsAccess.ts` + `commsSend.ts`)

**a. Write the failing test (RED).** Create `apps/convex/tests/commsSend.test.ts`.
It calls `api.commsSend.sendCommsToGoogleChat` — doesn't exist, genuine RED.
Seed helper: an `eventTypes` + `events` + one `eventItems` row with
`module: "comms"`, `fields: { notes: "Hey team, be on time." }` (mirror
`itemUnschedule.test.ts`'s `seedEventItem` shape), plus a second helper
seeding a `module: "planning_doc"` row, and a `googleChatChannels` row
inserted directly via `ctx.db.insert`. Cases:
- Sending against the `planning_doc` item is rejected (`ConvexError`); no
  scheduled function runs, item untouched.
- Sending with `message: "   "` (whitespace only) is rejected; nothing scheduled.
- Sending with an unknown/nonexistent `channelId` is rejected.
- Sending with an ARCHIVED channel's id is rejected.
- A caller from a DIFFERENT chapter (a second `setupChapter(t, { email: "other@publicworship.life" })`)
  is rejected the same way `requireEvent` rejects any other cross-chapter
  access (`ConvexError`).
- **Happy path**: valid comms item + configured channel + non-empty message.
  `vi.useFakeTimers()`; stub `globalThis.fetch` to resolve `{ ok: true }`;
  call the mutation; `await t.finishAllScheduledFunctions(vi.runAllTimers)`;
  read the item back — `status === "sent"`,
  `fields.lastGoogleChatSend === { channelId, channelName: "Leaders", status: "sent", sentAt: <number> }`
  (error absent). `vi.useRealTimers()` in a `finally`.
- **Failure path**: same setup, but stub `fetch` to resolve
  `{ ok: false, status: 500, text: async () => "oops" }`. After draining:
  `status` is whatever it was BEFORE the send (untouched — assert it did
  NOT become `"sent"`), `fields.lastGoogleChatSend.status === "failed"`,
  `.error` is a non-empty string that does not include the seeded webhook URL.

**b. Implement.**
- `lib/commsAccess.ts`:
  ```ts
  /**
   * The gate on sending a Comms Schedule row's copy to Google Chat
   * (`commsSend.ts#sendCommsToGoogleChat`). TODAY: bare event access — any
   * admin of the event's own chapter (`requireEvent`'s membership check) —
   * copying `campaignsAccess.ts#requireBlastSend`'s shape exactly, including
   * its "not yet a named capability" stance. Graduates the same three-step
   * way if it ever needs to: add `"comms.send"` to SEAT_CAPABILITIES, list it
   * on the seats that should carry it, change ONLY this function's body.
   */
  export async function requireCommsSend(ctx: QueryCtx, eventId: Id<"events">): Promise<Doc<"events">> {
    return await requireEvent(ctx, eventId);
  }
  ```
- `items.ts`: change `function mergeFields(` to `export function mergeFields(`.
- `commsSend.ts`:
  - `sendCommsToGoogleChat` (mutation): args
    `{ itemId: v.id("eventItems"), channelId: v.id("googleChatChannels"), message: v.string() }`.
    Loads the item (404 if missing), throws `NOT_COMMS` if
    `item.module !== "comms"`, calls `const event = await requireCommsSend(ctx, item.eventId)`,
    trims `message` and throws `EMPTY` if blank, loads the channel and throws
    `NOT_FOUND` if missing or `archived`, then
    `ctx.scheduler.runAfter(0, internal.commsSend.deliverCommsSend, { itemId, channelId, channelName: channel.name, eventName: event.name, itemTitle: item.title, message: message.trim() })`.
    Returns `null`.
  - `deliverCommsSend` (internalAction): args
    `{ itemId, channelId, channelName, eventName, itemTitle, message }`. Reads
    the webhook URL via `ctx.runQuery(internal.googleChatChannels.readGoogleChatWebhookUrl, { channelId })`;
    if `null` (channel archived/deleted in the gap), calls `finishCommsSend`
    with `ok:false, error: "Google Chat channel is no longer configured."`
    and returns. Otherwise builds the text with
    `buildGoogleChatMessage({ eventName, itemTitle, copy: message })`, tries
    `postGoogleChatMessage`, and calls `finishCommsSend` with `ok:true` or
    `ok:false, error: String(err)` in a try/catch (same shape as
    `deliverEmailBlast`'s try/catch around `sendResendEmailBatch`).
  - `finishCommsSend` (internalMutation): args
    `{ itemId, channelId, channelName, ok: v.boolean(), error: v.optional(v.string()) }`.
    Loads the item; if missing, no-ops. Builds
    `fields: mergeFields(item.fields, { lastGoogleChatSend: { channelId: String(channelId), channelName, status: ok ? "sent" : "failed", error: ok ? undefined : error, sentAt: Date.now() } })`.
    Patches `{ fields, ...(ok ? { status: "sent" } : {}) }` — status is
    ONLY touched on success, per the failure-path test above.

**c. Run the full suite.**

### 4. Google Chat channels admin card (mobile, superuser)

No new test file (this repo has no component-test coverage for the
Profile → Integrations cards — `TwilioCard`/`ResendCard` in `integrations.tsx`
have none either; verify by running the app, per CLAUDE.md's UI-change rule).

- Create `apps/mobile/components/integrations/GoogleChatChannelsCard.tsx`,
  following `TwilioCard`'s structure in `integrations.tsx` (own component
  file since it manages a LIST, not a single settings row — `TwilioUsageSummary.tsx`
  is the precedent for a standalone integrations sub-component):
  - `useQuery(api.googleChatChannels.getGoogleChatChannelsStatus, superuser ? {} : "skip")`.
  - A name + webhook-URL `TextField` pair (webhook `secureTextEntry`, like
    the Twilio auth token) + "Add channel" button →
    `addGoogleChatChannel`.
  - Each existing channel row: name (inline-rename via a second small
    `TextField`/`Button` pair, or a simple "Rename" prompt-style flow — match
    whatever inline-edit affordance `TwilioCard`/`ResendCard` already use for
    a single field), "Replace webhook" (`updateGoogleChatChannelWebhook`,
    write-only, never prefilled), "Archive"/"Restore" toggle
    (`archiveGoogleChatChannel`).
  - Same `errorMessage(e, "...")` + inline error/success `Text` pattern as
    every other card in the file.
- Wire it into `integrations.tsx`: `<GoogleChatChannelsCard channels={...} loading={...} />`
  after `<TwilioUsageSummary />`, following the existing `status?.<x>` prop pattern.
  Add `googleChatChannels` to `getIntegrationsStatus`'s response is NOT
  needed — this card queries `getGoogleChatChannelsStatus` directly (it's a
  list, not a single-row status projection like the others).

Verify by running the app (`pnpm dev` or the `/run` skill), signing in as a
superuser, and adding/renaming/archiving a channel on Profile → Integrations.

### 5. Send-to-Google-Chat button on the comms card (mobile)

No new test file (same rationale as step 4 — `BlastComposerCard.tsx`, the
closest analog, has none either).

- `ItemCardText.tsx`'s `CopyEditor`: add an optional
  `headerExtra?: React.ReactNode` prop, rendered inside the existing header
  row (`<View className="mb-1 flex-row items-center justify-between">`),
  after the `{value.trim() ? <CopyButton .../> : null}` line, so Copy and
  Send sit side by side exactly where the screenshot shows the "Copy" button
  today.
- Create `apps/mobile/components/event/moduleCalendar/SendToGoogleChatButton.tsx`:
  - Props: `{ item: ScheduleItem; message: string }` (item for `_id`/`fields.lastGoogleChatSend`,
    `message` = the ALREADY-SAVED copy text, passed down as `initialCopy` already is).
  - `useQuery(api.googleChatChannels.listGoogleChatChannels, {})`,
    `useMutation(api.commsSend.sendCommsToGoogleChat)`.
  - Renders nothing if `!message.trim()` (mirrors `CopyButton`'s own
    `value.trim() ?` guard right above it — nothing to send yet).
  - A small "Send" pressable (`Icon name="send"`) that measures its anchor
    (`measureAnchor`, same as `ItemCardStatus.tsx`'s `BadgeEditor` trigger)
    and opens a `Popover` listing channels (`Icon name="message-circle"` +
    name per row); empty state: "No Google Chat channels configured — a
    superuser can add one in Profile → Integrations."
  - Picking a channel calls `send({ itemId: item._id, channelId, message: message.trim() })`
    inside a local `try/catch` (`sending` state disables the button meanwhile;
    `error` state renders inline on failure, cleared on the next attempt) —
    self-contained, no toast plumbing threaded through `ItemCard`/`DayPanel`
    (this is a single-purpose per-card affordance, not a shared composer).
  - Below the button, read `item.fields?.lastGoogleChatSend` and render:
    - `status === "sent"`: a small success line, e.g. "Sent to {channelName}".
    - `status === "failed"`: a small danger line, e.g. "Couldn't send to
      {channelName}: {error}".
    - absent: nothing.
- `ItemCard.tsx`: add `canSendGoogleChat?: boolean` prop; pass
  `headerExtra={canSendGoogleChat ? <SendToGoogleChatButton item={item} message={initialCopy} /> : null}`
  into its `<CopyEditor .../>` call.
- `index.tsx`: in `renderItemCard`, pass `canSendGoogleChat={config.module === "comms"}`
  to `<ItemCard .../>` (same one-line, config-driven conditional style already
  used there for `badgeField`).

Verify by running the app: open an event's Comms Schedule (calendar view),
confirm the Send button appears on a comms card and is ABSENT on a Planning
Doc card, and (once at least one channel is configured per step 4) confirms
the full pick-a-channel → send → status flips to "Sent" loop live.

### 6. Academy wording fix

`packages/shared/src/academy/streams/events.ts`'s `tab-comms` lesson, the
Channel column's table row: change
`["**Channel**", "Where does it post — IG, the iMessage group, email, Slack?"]`
to say `"Google Chat"` instead of `"Slack"` — the org renamed this in #479
(`comms-calendar-slack-to-google-chat.md`) and the lesson never caught up.
This is a pure wording fix (no block added, no quiz/minutes change), so it
does not touch `academy.snapshot.test.ts`'s literal counts.

Deliberately NOT adding a new lesson block/tip about the Send button itself:
the mental model `tab-comms` teaches (comms is a row with audience/channel/
timing/copy; Sent is the terminal status) is unchanged by this PR — the Send
button is a UI affordance on top of it, not a new concept. Say so in the PR
description per CLAUDE.md's "decide explicitly... or 'not training-worthy'".

### 7. Final validation
Run every command in Validation Commands below and confirm a clean exit.

## Testing Strategy

### Tests by Milestone

| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | Google Chat message + send helpers | `apps/convex/tests/googleChat.test.ts` (new) | `buildGoogleChatMessage` formats heading+copy correctly (with/without a title); `postGoogleChatMessage` POSTs the right body/headers and throws a status+body error that never contains the webhook URL | `lib/googleChat.ts` doesn't exist |
| 2 | Google Chat channels: schema + CRUD | `apps/convex/tests/googleChatChannels.test.ts` (new) | superuser-only writes; `listGoogleChatChannels` never carries `webhookUrl`; invalid URL format rejected; archived channels excluded from the public list but visible (flagged) to a superuser | `googleChatChannels.ts` / the table don't exist |
| 3 | Comms send flow | `apps/convex/tests/commsSend.test.ts` (new) | non-comms/empty-message/unknown-or-archived-channel/cross-chapter all rejected with nothing scheduled; a successful send flips `status` to `"sent"` and records `fields.lastGoogleChatSend`; a failed send leaves `status` untouched and records a `"failed"` outcome with a URL-free error | `commsSend.ts` doesn't exist |
| 4 | Google Chat channels admin card | N/A — manual verification via the app (see step 4's closing paragraph); matches this repo's convention of no component tests for the Profile → Integrations cards (`TwilioCard`/`ResendCard` have none) | Add/rename/replace-webhook/archive round-trip correctly in the running app | The card doesn't exist |
| 5 | Send button on the comms card | N/A — manual verification via the app (see step 5's closing paragraph); mirrors `BlastComposerCard.tsx` having no test file either | Button appears on comms cards only; pick-a-channel → send → live status update works | The button doesn't exist |
| 6 | Academy wording fix | `packages/shared/src/academy.snapshot.test.ts` (existing, must stay green) | The pure wording edit doesn't change any section/quiz/minutes count the snapshot pins | N/A — this is a non-breaking edit verified by an EXISTING test staying green, not a new one |

**Pattern followed:** `apps/convex/tests/blasts.test.ts` for the scheduled-action
send-flow tests (milestone 3); `apps/convex/tests/integrationSettings.test.ts`
for the superuser-gate + write-only-secret tests (milestone 2).

### Integration Tests
N/A beyond milestone 3's own coverage — `commsSend.test.ts` already exercises
the full seam end-to-end (mutation schedules → action reads the channel →
action posts → finalize mutation patches the item), which IS the integration
point this feature adds. There's no separate integration surface to cover.

### Edge Cases
- Empty/whitespace-only copy: the Send button renders nothing client-side
  (step 5) AND the mutation independently rejects it server-side (milestone 3) —
  belt-and-suspenders, since the client-side guard alone would let a
  crafted/stale call through.
- Zero channels configured: `listGoogleChatChannels` returns `[]`; the picker
  shows the empty-state hint instead of an empty popover (milestone 2 backend
  contract + step 5 UI).
- A channel archived AFTER the picker loaded it but BEFORE the send lands:
  covered by `deliverCommsSend`'s `null`-webhook-URL branch (milestone 3) —
  records a `"failed"` outcome instead of throwing unhandled, closing that
  timing gap.
- Webhook POST throws (network failure) vs. returns non-2xx: both land in
  `deliverCommsSend`'s catch as a `"failed"` outcome (milestone 3's failure-path
  test covers the non-2xx case; the throw case shares the same catch block).
- Re-sending after a failure: clicking Send again overwrites
  `fields.lastGoogleChatSend` with the new attempt's outcome (no special
  "already failed" lockout) — implicit in `finishCommsSend`'s unconditional patch.
- Cross-chapter access: covered explicitly in milestone 3's test list.

## Acceptance Criteria
- [ ] A comms-module event item's day-panel card shows a Send affordance next
      to the Copy button in the COPY section; it is absent on planning_doc cards.
- [ ] Tapping Send with zero Google Chat channels configured shows an
      empty-state hint and calls no mutation.
- [ ] Tapping Send with channels configured opens a picker listing every
      non-archived channel by name.
- [ ] Picking a channel sends the item's SAVED copy (not an unsaved draft) via
      `commsSend.sendCommsToGoogleChat`; a non-comms item, an empty message, or
      an unknown/archived channel is rejected server-side.
- [ ] On a successful send, the item's `status` becomes `"sent"` and
      `fields.lastGoogleChatSend` records `{channelId, channelName,
      status:"sent", sentAt}` — with no separate manual status edit.
- [ ] On a failed send, `status` is left untouched and
      `fields.lastGoogleChatSend.status === "failed"` carries a
      human-readable error that never contains the webhook URL.
- [ ] `addGoogleChatChannel` / `renameGoogleChatChannel` /
      `updateGoogleChatChannelWebhook` / `archiveGoogleChatChannel` are all
      rejected for a non-superuser, with no row written or changed.
- [ ] `listGoogleChatChannels` never includes `webhookUrl`; the superuser
      status query never returns the full URL, only a short suffix hint.
- [ ] A caller outside the comms item's event/chapter is rejected by
      `sendCommsToGoogleChat`.
- [ ] Profile → Integrations shows a Google Chat card (superuser-only) to
      add/rename/replace-webhook/archive channels, matching the existing
      Twilio/Resend card styling.
- [ ] The `tab-comms` Academy lesson's channel example says "Google Chat", not
      "Slack".
- [ ] All Validation Commands pass.

## Validation Commands
Execute every command. Every one must exit clean.
- `pnpm install --frozen-lockfile`
- `pnpm --filter @events-os/convex typecheck`
- `pnpm --filter @events-os/convex exec vitest run tests/googleChat.test.ts tests/googleChatChannels.test.ts tests/commsSend.test.ts` — fast feedback on the new tests specifically
- `pnpm --filter @events-os/convex test` — full backend suite, zero regressions
- `pnpm --filter @events-os/shared test` — includes `academy.snapshot.test.ts`; must stay green after the wording fix
- `pnpm --filter @events-os/shared typecheck`
- `pnpm turbo run test` — full fan-out
- `pnpm turbo run build`

## Notes

### Where the user is explicitly needed
1. **Creating the actual Google Chat Incoming Webhook URLs.** This PR ships
   the plumbing and the admin UI, but only a human with access to the org's
   Google Chat spaces can create one (per space: Google Chat → the space →
   "Apps & integrations" → "Webhooks" → "Add webhook", copy the generated
   URL). A superuser then pastes each one into the new Profile → Integrations
   → Google Chat card after this ships. Until at least one is configured, the
   Send button's picker will show "No Google Chat channels configured" —
   expected, not a bug.
2. **Confirm the message format.** This plan proposes
   `*{item title}* — {event name}\n\n{copy}` (Google Chat's basic markdown
   bold). Easy to change post-ship in `lib/googleChat.ts#buildGoogleChatMessage`
   if a different format/branding is wanted (e.g. no title line, a signature,
   an emoji prefix).
3. **Decide the channel names/spaces to create** (e.g. "Leaders", "Volunteers",
   "General", one per audience the org actually messages) — this PR doesn't
   guess at that list.

### Deferred / explicitly out of scope
- Automatic/scheduled sending on a row's due date.
- Per-chapter channel scoping.
- Sending from the Table view.
- A full send-history list (only the most recent outcome per row is tracked).
- A `comms.send` seat capability (the access gate is written so this is a
  one-file change later, per `lib/commsAccess.ts`'s doc).
