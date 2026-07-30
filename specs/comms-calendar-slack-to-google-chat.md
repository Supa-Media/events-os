# Chore: Replace "Team Slack" with Google Chat in the comms calendar

## Chore Description

The org has stopped using Slack for team comms and moved to Google Chat. The
Comms Schedule calendar (the per-event "comms" module — screenshot:
`Tasks | Comms Schedule | Run of Show | ...` tab, calendar view with a
channel legend at the bottom) still ships a `team_slack` channel option
labeled "Team Slack" with a Slack glyph. That option shows up as a badge on
calendar cards, in the overlapping channel-logo cluster, in the bottom
legend, and as a toggle in the "Add send" composer — anywhere a comms send's
channel is displayed or picked.

Critically, a **separate `google_chat` option already exists** in the same
list (`{ value: "google_chat", label: "Google Chat", color: "green" }`),
added when Google Chat was first introduced. Now that Slack is gone
entirely, having both is a duplicate/dead option: `team_slack` must be
deleted (not just relabeled), and every place seed/demo data used
`"team_slack"` must be repointed at `"google_chat"` so existing comms items
keep a valid, correct channel badge instead of silently falling back to the
generic "send" icon.

The planning playbook (`docs/agent.md`, compiled into
`packages/shared/src/playbook.ts`) also documents the comms cadence and
names "Slack" as the channel for several cadence rows — this is the doc the
AI assistant reads when suggesting comms sends, so it must say "Google Chat"
too or the assistant will keep suggesting a channel that no longer exists.

## Scope

**In scope:**
- The `channel` option list for the comms calendar
  (`COMMS_CHANNEL_OPTIONS` in `packages/shared/src/index.ts`): delete the
  `team_slack` entry entirely (do not rename it — `google_chat` already
  covers that label).
- The channel-icon lookup for the comms calendar
  (`CHANNEL_ICON` in `apps/mobile/components/event/moduleCalendar/config.ts`):
  delete the `team_slack: "slack"` mapping.
- Every seed/demo dataset that assigns `channel: [..., "team_slack", ...]`
  to a comms item: change `"team_slack"` to `"google_chat"`, de-duplicating
  the array if `"google_chat"` is already present alongside it.
- The comms cadence table in `docs/agent.md` (and its generated mirror
  `packages/shared/src/playbook.ts`, regenerated via the sync script — do
  not hand-edit `playbook.ts`): replace "Slack" with "Google Chat" in the
  `Channel` column.

**Out of scope:**
- The `google_chat` option itself — it already exists with the correct
  label ("Google Chat") and icon (`message-circle`); leave it as-is.
- `commsPreferences` on the person schema
  (`apps/convex/schema/people.ts`) and its UI placeholder text
  (`apps/mobile/app/(app)/(tabs)/people.tsx`) — this is a free-text,
  per-person "how do I like to be reached" list unrelated to the comms
  calendar's structured channel field. Not touched.
- Non-comms-calendar occurrences of the English word "slack" (e.g.
  "the plan had slack", "slacking on X", `SWEEP_STALE_MS` backoff comment,
  `orgWorkload.overdue.test.ts` doc comment) — these are unrelated to the
  Slack app and must not be changed.
- `packages/shared/src/academy/streams/management.ts` — its "Slack seat"
  references are about org onboarding access to internal tools generally,
  not the comms calendar's channel option. Not touched.
- `apps/convex/tests/financeCentralTransactions.test.ts` ("Reimbursed via
  Slack DM") — a finance test fixture unrelated to the comms calendar.
- Historical planning specs under `specs/` (e.g.
  `specs/love-thy-neighbor-template.md`) that reference `team_slack` as
  part of an already-implemented plan's task list — these are frozen
  records of what was planned, not live product surface. Not touched.
- `docs/guides/so-you-own-an-event.md`, `docs/notion-reference/*.md` — verify
  during implementation whether they mention Slack in a comms-calendar
  context; if so, treat as in scope by the same rule as `docs/agent.md`
  (see Step by Step Tasks).
- Any IconName/Feather glyph registry change — `"slack"` remains a valid
  Feather icon name in `apps/mobile/components/ui/Icon.tsx`'s type; we're
  only removing its one usage, not the type entry (Feather ships it, no
  local SVG asset to delete).

## Relevant Files

- `packages/shared/src/index.ts:617-626` — `COMMS_CHANNEL_OPTIONS`; delete
  the `team_slack` row (line 618).
- `apps/mobile/components/event/moduleCalendar/config.ts:84-93` —
  `CHANNEL_ICON`; delete the `team_slack: "slack"` row (line 85).
- `apps/convex/lib/seed/loveThyNeighbor.ts:65,67` — two `channel: [...,
  "team_slack"]` arrays to repoint to `"google_chat"`.
- `apps/convex/lib/seed/templates.ts:199,598,1169,1170,1172,1276,1277,1279`
  — eight `channel: [..., "team_slack", ...]` arrays to repoint.
- `apps/convex/lib/seed/fieldDay.ts:23,24,26,38,42,46` — six
  `channel: [..., "team_slack", ...]` arrays to repoint (line 26 combines
  `imessage_group` and `team_slack` — de-dupe, don't just find/replace
  blindly if `google_chat` were already present, though it is not here).
- `docs/agent.md:310,311,313,316,318` — comms cadence table rows naming
  "Slack" as the channel; change to "Google Chat".
- `packages/shared/src/playbook.ts` — **do not hand-edit**; regenerate from
  `docs/agent.md` via `node scripts/sync-playbook.mjs` after the doc edit,
  per the file's own header instructions.

Search commands used to build this list (re-run to confirm completeness
before starting):
```
grep -rn "team_slack" --exclude-dir=node_modules --exclude-dir=.git .
grep -rln "slack" --exclude-dir=node_modules --exclude-dir=.git . -i
```
The second command additionally surfaces the out-of-scope files listed
above — confirm no new in-scope hits appeared since this plan was written
(e.g. a new seed template landed on `main` after this plan).

### New Files
None.

## Step by Step Tasks

### 1. Remove the `team_slack` channel option (shared package first — it's the source of truth every consumer reads)
- In `packages/shared/src/index.ts`, delete the `{ value: "team_slack", label: "Team Slack", color: "red" }` line from `COMMS_CHANNEL_OPTIONS`, leaving `google_chat` as the first entry.

### 2. Remove the now-dead icon mapping
- In `apps/mobile/components/event/moduleCalendar/config.ts`, delete the `team_slack: "slack",` line from `CHANNEL_ICON`. Leave `google_chat: "message-circle"` untouched.

### 3. Repoint seed/demo data from `team_slack` to `google_chat`
- `apps/convex/lib/seed/loveThyNeighbor.ts`: on both lines with `channel: ["imessage_group", "team_slack"]`, change `"team_slack"` to `"google_chat"`.
- `apps/convex/lib/seed/templates.ts`: on every `channel: [...]` array containing `"team_slack"` (lines 199, 598, 1169, 1170, 1172, 1276, 1277, 1279), change `"team_slack"` to `"google_chat"`. None of these arrays currently also contain `"google_chat"`, so this is a plain value swap, not a de-dupe.
- `apps/convex/lib/seed/fieldDay.ts`: on every `channel: [...]` array containing `"team_slack"` (lines 23, 24, 26, 38, 42, 46), change `"team_slack"` to `"google_chat"`. Line 26's array is `["ig_stories", "imessage_group", "team_slack"]` → `["ig_stories", "imessage_group", "google_chat"]`.
- After editing, re-run `grep -rn "team_slack" apps/convex/lib/seed/` and confirm zero hits.

### 4. Update the planning playbook doc
- In `docs/agent.md`, in the "Communication is a planned artifact" section's cadence table (around line 300-318), replace every standalone "Slack" cell value and the "Slack" token inside the `IG, Slack, group` cell with "Google Chat" (so that cell reads `IG, Google Chat, group`). Do not touch unrelated uses of the word "slack" elsewhere in the file (e.g. "the plan had slack and a fallback").
- Regenerate the compiled copy: run `node scripts/sync-playbook.mjs` from the repo root. Confirm it rewrites `packages/shared/src/playbook.ts` and that a subsequent `git diff packages/shared/src/playbook.ts` shows only the Slack → Google Chat changes (plus any unrelated whitespace the generator normally produces — none expected).

### 5. Check the remaining docs called out as conditionally in-scope
- Grep `docs/guides/so-you-own-an-event.md` and `docs/notion-reference/*.md` for "slack" (case-insensitive). If any hit describes the comms calendar's channel options (as opposed to an unrelated mention), update "Slack" to "Google Chat" there too, consistent with the rest of this chore. If the hits are unrelated (e.g. general org history/notes), leave them — do not touch out-of-scope files listed above.

### 6. Sweep for stragglers
- Run `grep -rn "team_slack" --exclude-dir=node_modules --exclude-dir=.git .` — must return zero results repo-wide (the historical `specs/*.md` files are the one intentional exception per Scope; confirm any remaining hits are only in `specs/`).
- Run `grep -rn "\"Team Slack\"\|'Team Slack'" --exclude-dir=node_modules --exclude-dir=.git .` — must return zero results.

### 7. Validate
- Run the Validation Commands below. All must pass clean.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm install --frozen-lockfile` — install deps
- `pnpm --filter @events-os/shared typecheck` — typecheck shared (catches any `COMMS_CHANNEL_OPTIONS`/`playbook.ts` type issues)
- `pnpm --filter @events-os/shared test` — shared tests (vitest)
- `pnpm --filter @events-os/convex typecheck` — typecheck backend (catches seed file issues)
- `pnpm --filter @events-os/convex test` — backend tests (vitest, ~150 files) — the primary gate; confirms no test depended on `team_slack`
- `pnpm --filter @events-os/mobile typecheck` — typecheck mobile app (catches `config.ts`/`badges.tsx` usages of `channelIcon`/`CHANNEL_ICON`)
- `grep -rn "team_slack" --exclude-dir=node_modules --exclude-dir=.git .` — must return only `specs/love-thy-neighbor-template.md` hits (or nothing, if none)
- `git diff packages/shared/src/playbook.ts` — eyeball that the regenerated diff is exactly the Slack → Google Chat swap, nothing else

## Notes

- No Convex schema or migration change is needed — the `channel` field is
  stored as `string[]` with option validation happening client-side via
  `COMMS_CHANNEL_OPTIONS`, not as a backend literal union. Existing
  production documents with `"team_slack"` already saved in their `channel`
  array will fall back to the generic "send" icon and lose their color/label
  in the UI once the option is deleted (same as any other now-unknown
  value) — this is a pre-existing, accepted behavior of the option system
  (see `channelIcon()`'s `?? "send"` fallback in `config.ts`) and is out of
  scope to backfill via a data migration unless the user asks for one.
- `pnpm --filter @events-os/mobile typecheck` (`tsc --noEmit`) is confirmed
  present in `apps/mobile/package.json`.
