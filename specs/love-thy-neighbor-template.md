# Feature: Give "Love Thy Neighbor" its own real, seedable template content

## Feature Description
Today the "Love Thy Neighbor" (LTN) event template is a structural clone of
Eden — `buildChapterRolesAndTemplates` inserts an `eventTypes` row named "Love
Thy Neighbor" with `deriveFromEventTypeId: edenId` and then copies every one
of Eden's roles/columns/items verbatim onto it. It carries none of the real
2025 Love Thy Neighbor plan. This feature ports the actual "Love Thy Neighbor
- Planning tasks" Notion doc (the real outdoor block-party outreach event
Public Worship ran on 2025-09-20) into LTN's own generic, reusable template
content — genericized (no real names, no last year's dollar amounts, event
day/times converted to event-relative offsets) and owner fields mapped to the
4 real template role keys — so that every future LTN event starts pre-loaded
with the actual playbook instead of Eden's rows under a different name.

## User Story
As a chapter lead creating a "Love Thy Neighbor" event
I want the template's Tasks, Comms Schedule, Run of Show, Crew expectations,
Permits, and Supplies tabs pre-filled with the real LTN playbook (not Eden's
generic rows)
So that I can run the event without reconstructing the plan from scratch or
relying on one person's memory of how it went last time

## Problem Statement
`buildChapterRolesAndTemplates` (`apps/convex/lib/seed/templates.ts:1193-1242`)
seeds LTN by deep-cloning Eden's own item rows. That means every chapter's LTN
template today literally says things like "Reach out to marketing for flyer"
and "Charcuterie supplies" — Eden's flagship-worship content — instead of
anything about permits for an outdoor public gathering, guest worship-leader
coordination, a prayer station, or the T-minus comms cadence the team actually
ran last year. The real plan exists only in a Notion doc tied to one specific
past event (with real names, real dollar figures, and absolute 2025 dates),
not as reusable template content.

## Solution Statement
Follow the codebase's own precedent for exactly this kind of port: "Field Day"
(`apps/convex/lib/seed/fieldDay.ts` + `seed.fieldDayTemplate` in
`apps/convex/seed.ts`) ported a Notion plan into `ItemRow[]` literals per
module, computed via `daysToEvent`/`minsFromStart` helpers so times are
relative to the event instead of hardcoded to one year, and inserted through
the existing `seedTemplateRoles` / `seedTemplateCols` / `addTemplateItems`
helpers. This plan applies the same technique to LTN, but wires it in at LTN's
actual seeding site (`buildChapterRolesAndTemplates`, alongside Eden's own
inline construction — the same treatment Eden gets, not a clone of it) rather
than as a wholly separate one-off template, since LTN is already one of the
three default templates every chapter gets. A second, small standalone
mutation (`seed.upgradeLoveThyNeighborTemplate`, mirroring
`seed.fieldDayTemplate`'s shape) is added so this new content can be pushed
into the one chapter that's already been bootstrapped in production (where
`ensureChapters` is a no-op today because the chapter already exists) without
disturbing that chapter's `eventTypes` row identity — it patches the existing
row and replaces its child rows in place, rather than deleting/recreating the
`eventTypes` document, so any already-created LTN event stays intact
(`instantiateEvent` deep-copies at event-creation time; nothing re-reads the
template afterward per `templateSync`'s diff/promote-only design, so
in-place replacement is safe).

Owner mapping: the 4 template role keys already carry the exact split this
event needs — `event_lead` (final call, permits, budget), `comms_lead`
("anything that contacts people outside the team" — this is explicitly
guest-worship-leader/volunteer/social comms per its own description),
`logistics_lead` (packing, day-of physical setup), `production_lead`
(audio/video, run-of-show, content capture). Every ported row's owner is
inferred onto one of these four keys; no real names are carried over (the
2025 Notion doc's names, dollar amounts, and vendor names are dropped or
genericized — this is a reusable template, not a historical record).

## Scope
**In scope:**
- A new seed-data file, `apps/convex/lib/seed/loveThyNeighbor.ts`, with the
  ported `ItemRow[]` literals for all 7 grid modules + a description.
- Replacing the "derive from Eden, clone its rows" LTN block inside
  `buildChapterRolesAndTemplates` with LTN's own independent construction
  (own `eventTypes` row, own roles, own columns, own items — same shape as
  Eden's own construction, just using the new LTN content).
- A new `seed.upgradeLoveThyNeighborTemplate` internal mutation in
  `apps/convex/seed.ts` that upserts this content onto an already-seeded
  chapter's existing "Love Thy Neighbor" `eventTypes` row (find-by-slug,
  patch description/clear `deriveFromEventTypeId`, delete + reinsert its
  `templateRoles`/`templateColumns`/`templateItems`), runnable via
  `npx convex run seed:upgradeLoveThyNeighborTemplate --prod`.
- Tests covering: LTN row data role-key validity, that
  `buildChapterRolesAndTemplates` gives LTN independent (non-cloned) content,
  and that the upgrade mutation replaces an existing chapter's stale LTN
  content in place and is idempotent.

**Out of scope:**
- Changing Eden's or Worship With Strangers's own seed content.
- Any UI change — this is seed-data only; the existing Templates/event-item
  grids already render whatever `templateItems` rows exist.
- Actually running `npx convex run seed:upgradeLoveThyNeighborTemplate --prod`
  against the live deployment — that's a follow-up operational step after
  this PR merges and CI is green (per the standing Agent Delivery Workflow:
  ship the code, don't execute prod data mutations as part of the PR).
- Academy updates. Grepped `packages/shared/src/academy/` for "Love Thy
  Neighbor"/"LTN"/"derived from Eden" — the only hits are unrelated
  fundraising-tier copy (backer milestones). No lesson teaches LTN's template
  structure or describes it as an Eden derivative, so nothing there goes
  stale. Stated explicitly per `CLAUDE.md`'s "say so in the PR description"
  guidance.

## Relevant Files
- `apps/convex/lib/seed/templates.ts` — **pattern to follow**: Eden's own
  inline construction (lines 1118-1191) is the shape LTN's new block should
  match; the current "derive from Eden" LTN block (lines 1193-1242) is what
  gets replaced.
- `apps/convex/lib/seed/fieldDay.ts` — **pattern to follow**: the exact
  precedent for porting a Notion plan into `ItemRow[]` literals with
  `daysToEvent`/`minsFromStart` helpers.
- `apps/convex/lib/seed/helpers.ts` — `ItemRow` type, `addTemplateItems`,
  `seedTemplateCols` — the insertion primitives this plan reuses unchanged.
- `apps/convex/lib/templates.ts` — `seedTemplateRoles` (lines 166-184),
  `toSlug` (lines 29-35) — reused unchanged.
- `apps/convex/seed.ts` — `fieldDayTemplate` (lines 1330-1397) is the
  **pattern to follow** for the new `upgradeLoveThyNeighborTemplate`
  mutation's shape (chapter/user fallback resolution, `internalMutation`,
  no-auth CLI-only doc comment). `ensureChapters` (lines 769-814) shows why a
  standalone upgrade path is needed: it's a no-op once the chapter exists.
- `packages/shared/src/index.ts` — `DEFAULT_ROLES`/`LIGHTWEIGHT_ROLE_KEYS`
  (lines 27-61, the 4 role keys to map owners onto), `GRID_CORE_MODULE_KEYS`
  (module list to seed columns for), `DEFAULT_COLUMNS` (lines 731-817, the
  exact `fields` bag keys/enums each module accepts —
  `TASK_STATUS_OPTIONS`/`COMMS_STATUS_OPTIONS`/`SUPPLY_STATUS_OPTIONS`/
  `PERMIT_STATUS_OPTIONS`, `COMMS_CHANNEL_OPTIONS`, `COMMS_AUDIENCE_OPTIONS`,
  `SUPPLY_SOURCE_OPTIONS`, `VOLUNTEER_TEAM_OPTIONS`).
- `apps/convex/schema/templates.ts`, `apps/convex/schema/roles.ts` — the
  `eventTypes`/`templateColumns`/`templateItems`/`templateRoles` shapes this
  plan writes into (no schema change needed — no new fields).
- `apps/convex/tests/templateClone.test.ts` — shows the exact
  `by_template`/`by_eventType` index names and the `run(t, ...)`/`setupChapter`
  test-helper pattern this plan's new tests reuse.
- `apps/convex/tests/importRoster.test.ts` — shows the exact pattern for
  invoking a `seed.ts` `internalMutation` from a test:
  `await t.mutation(internal.seed.importRoster, {})`.

### New Files
- `apps/convex/lib/seed/loveThyNeighbor.ts` — the ported `ItemRow[]` literals
  (`LTN_PLANNING`, `LTN_COMMS`, `LTN_RUN_OF_SHOW`, `LTN_VOLUNTEER`,
  `LTN_PERMITS`, `LTN_SUPPLIES`, `LTN_RETRO`), `LTN_ROWS_BY_MODULE` (the
  `Record<ModuleKey, ItemRow[]>` both call sites iterate), and
  `LTN_DESCRIPTION`.
- `apps/convex/tests/loveThyNeighborTemplate.test.ts` — the 3 milestones'
  tests (row-data validity, independent template construction, upgrade
  mutation behavior).

## Implementation Plan

### Phase 1: Foundation — the ported seed data
Write `apps/convex/lib/seed/loveThyNeighbor.ts`: the event-relative date
helpers (`daysToEvent`/`minsFromStart`, same shape as `fieldDay.ts`, anchored
to the real 2025-09-20 event day and its 3:45 PM welcome/worship start so the
offsets are correct, but the constants themselves are not exported — only the
resulting relative offsets are baked into the `ItemRow[]` literals, exactly
like `fieldDay.ts`), then the 7 `ItemRow[]` arrays with the full ported +
genericized content (given verbatim in Step by Step Tasks below, since this
plan's implementor has no access to the source Notion doc).

### Phase 2: Core Implementation — wire LTN into `buildChapterRolesAndTemplates`
Replace the current "derive from Eden, clone every row" LTN block in
`apps/convex/lib/seed/templates.ts` with LTN's own inline construction:
insert its own `eventTypes` row (`description: LTN_DESCRIPTION`, no
`deriveFromEventTypeId`), its own roles via `seedTemplateRoles(ctx, ltnId,
DEFAULT_ROLES)`, its own columns via the `GRID_CORE_MODULE_KEYS` loop (same
as Eden), then iterate `LTN_ROWS_BY_MODULE` calling `addTemplateItems` per
module — the same shape Eden's own block already uses, just pointed at the
new data.

### Phase 3: Integration — push the new content into an already-seeded chapter
Add `seed.upgradeLoveThyNeighborTemplate` to `apps/convex/seed.ts`: resolve
chapter/user (same optional-args-with-first-row-fallback pattern as
`fieldDayTemplate`), find the chapter's existing "Love Thy Neighbor"
`eventTypes` row by `by_chapter_slug`, and if found, patch its
description/`disabledCoreModules`/clear `deriveFromEventTypeId`/`updatedAt`
and delete-then-reinsert its `templateRoles`/`templateColumns`/`templateItems`
children (idempotent — safe to re-run); if not found, insert it fresh. Both
branches finish by seeding roles/columns/`LTN_ROWS_BY_MODULE` items, same as
Phase 2's block.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Write the ported seed data (`apps/convex/lib/seed/loveThyNeighbor.ts`)

**a. RED — write the failing test first.** Create
`apps/convex/tests/loveThyNeighborTemplate.test.ts` with this first `describe`
block (the file doesn't exist yet, so this is a genuine RED — an import
error):

```ts
import { describe, expect, test } from "vitest";
import { DEFAULT_ROLES } from "@events-os/shared";
import {
  LTN_PLANNING,
  LTN_COMMS,
  LTN_RUN_OF_SHOW,
  LTN_VOLUNTEER,
  LTN_PERMITS,
  LTN_SUPPLIES,
  LTN_RETRO,
  LTN_ROWS_BY_MODULE,
  LTN_DESCRIPTION,
} from "../lib/seed/loveThyNeighbor";

/**
 * The ported Love Thy Neighbor row data must only ever reference the 4 real
 * template role keys — a typo'd role key silently resolves to `undefined` at
 * insert time (`addTemplateItems`'s `roleIdByKey[r.role]` doesn't throw on a
 * miss), so this is the only guardrail against a row quietly losing its owner.
 */
describe("Love Thy Neighbor seed data", () => {
  const validKeys = new Set(DEFAULT_ROLES.map((r) => r.key));
  const allRows = [
    ...LTN_PLANNING,
    ...LTN_COMMS,
    ...LTN_RUN_OF_SHOW,
    ...LTN_VOLUNTEER,
    ...LTN_PERMITS,
    ...LTN_SUPPLIES,
    ...LTN_RETRO,
  ];

  test("every row's role key is a real DEFAULT_ROLES key", () => {
    for (const row of allRows) {
      if (row.role) expect(validKeys.has(row.role)).toBe(true);
    }
  });

  test("LTN_ROWS_BY_MODULE covers all 7 grid modules with the matching arrays", () => {
    expect(LTN_ROWS_BY_MODULE.planning_doc).toBe(LTN_PLANNING);
    expect(LTN_ROWS_BY_MODULE.comms).toBe(LTN_COMMS);
    expect(LTN_ROWS_BY_MODULE.run_of_show).toBe(LTN_RUN_OF_SHOW);
    expect(LTN_ROWS_BY_MODULE.volunteer_expectations).toBe(LTN_VOLUNTEER);
    expect(LTN_ROWS_BY_MODULE.permits).toBe(LTN_PERMITS);
    expect(LTN_ROWS_BY_MODULE.supplies).toBe(LTN_SUPPLIES);
    expect(LTN_ROWS_BY_MODULE.retro).toBe(LTN_RETRO);
  });

  test("planning_doc rows outnumber Eden's 10 (this is LTN's own content, not a clone)", () => {
    expect(LTN_PLANNING.length).toBeGreaterThan(10);
  });

  test("description is set and does not mention Eden", () => {
    expect(LTN_DESCRIPTION.length).toBeGreaterThan(0);
    expect(LTN_DESCRIPTION.toLowerCase()).not.toContain("eden");
  });
});
```

Run `cd apps/convex && pnpm vitest run tests/loveThyNeighborTemplate.test.ts`
and confirm it fails on the import (module doesn't exist).

**b. GREEN — implement the minimum.** Create
`apps/convex/lib/seed/loveThyNeighbor.ts` with exactly this content:

```ts
/**
 * "Love Thy Neighbor" template seed rows, ported from the Notion "Love Thy
 * Neighbor - Planning tasks" doc for the 2025-09-20 event.
 *
 * An outdoor, pre-announced neighborhood block-party worship gathering — a
 * full band + guest worship leaders, a prayer station, and an open invitation
 * to the surrounding community. Timing is RELATIVE to the event: day offsets
 * for the day-modules (Planning, Comms, Permits, Supplies) and minute offsets
 * from the 3:45 PM welcome/worship start for Run of Show, so the template
 * reuses cleanly each year. Real names, vendor names, and last year's dollar
 * figures are genericized — this is a reusable template, not a historical
 * record. Consumed by `buildChapterRolesAndTemplates` and
 * `seed.upgradeLoveThyNeighborTemplate`.
 */
import type { ModuleKey } from "@events-os/shared";
import type { ItemRow } from "./helpers";

const EVENT_DAY = "2025-09-20";
const PROGRAM_START = "2025-09-20T15:45:00"; // 3:45 PM welcome / worship start
const daysToEvent = (iso: string) =>
  Math.round((Date.parse(iso) - Date.parse(EVENT_DAY)) / 86_400_000);
const minsFromStart = (iso: string) =>
  Math.round((Date.parse(iso) - Date.parse(PROGRAM_START)) / 60_000);

export const LTN_DESCRIPTION =
  "Outdoor neighborhood block party — a full band and guest worship leaders, a prayer station, and an open invitation to the surrounding community. Bigger than Worship With Strangers: it takes permits, staging, a production team, and a full comms runway to land well.";

// ── Tasks (planning_doc) ──────────────────────────────────────────────────
export const LTN_PLANNING: ItemRow[] = [
  { title: "Draft the planning document", offsetDays: daysToEvent("2025-08-09"), role: "event_lead", fields: { details: "High-level brief capturing the event date, goals, scope, and budget." } },
  { title: "Hold the project brief meeting", offsetDays: daysToEvent("2025-08-16"), role: "event_lead", fields: { details: "Set a calendar invite and walk the team through the project brief — goals, date, high-level scope." } },
  { title: "Reach out to guest worship leaders", offsetDays: daysToEvent("2025-08-23"), role: "comms_lead", fields: { details: "Send the intro email: event overview, confirm dates and availability. Follow up until every guest worship leader has confirmed." } },
  { title: "Open the RSVP link", offsetDays: daysToEvent("2025-09-07"), role: "comms_lead", fields: { details: "Stand up the RSVP link on your ticketing platform of choice — no attendance cap." } },
  { title: "Engage a production vendor", offsetDays: daysToEvent("2025-09-08"), role: "production_lead", fields: { details: "Contract a production vendor for sound + power, including crew, backline, and front-of-house. Confirm whether they'll record multitrack audio." } },
  { title: "Create the flyer + social announcement", offsetDays: daysToEvent("2025-09-08"), role: "comms_lead", fields: { details: "One flyer for the general announcement, one aimed at guests who'll be worshipping at the event." } },
  { title: "Confirm guest worship leaders", offsetDays: daysToEvent("2025-09-09"), role: "comms_lead", fields: { details: "Lock the final worship-leader lineup for the day." } },
  { title: "Confirm venue + file permits", offsetDays: daysToEvent("2025-09-09"), role: "event_lead", fields: { details: "File the Parks & Recreation permit and the amplified-sound permit — can't proceed without both. See the Permits tab." } },
  { title: "Recruit photo/video volunteers", offsetDays: daysToEvent("2025-09-10"), role: "production_lead", fields: { details: "Confirm what's being captured, make sure cameras can sync in post, and get footage uploaded promptly so nothing is lost. Aim for at least one dedicated photographer." } },
  { title: "Volunteer solicitation + engagement", offsetDays: daysToEvent("2025-09-13"), role: "comms_lead", fields: { details: "Ask team members to fill volunteer roles first, assign volunteer leads, write detailed instructions per role, set up the shift/volunteer/lead table, and open a signup survey." } },
  { title: "Line up a DJ / ambient playlist", offsetDays: daysToEvent("2025-09-12"), role: "production_lead", fields: { details: "Have someone curate a playlist to play in the background before and between sets." } },
  { title: "Order signage + print materials", offsetDays: daysToEvent("2025-09-06"), role: "logistics_lead", fields: { details: "QR-code giving cards, prayer / come-worship signage (vary the wording), a standing sign for the prayer team, and volunteer shirts. See the Supplies tab." } },
  { title: "Build the comms + content schedule", offsetDays: daysToEvent("2025-09-06"), role: "comms_lead", fields: { details: "Plan comms to volunteers, RSVP'd guests, social, and the team — draft the copy for each. See the Comms Schedule tab." } },
  { title: "Plan event catering", offsetDays: daysToEvent("2025-09-08"), role: "logistics_lead", fields: { details: "Set a food budget, make sure water is free, and line up a food vendor — check pricing and whether they need a minimum sales guarantee or a flat rental fee." } },
  { title: "Create and finalize the run of show", offsetDays: daysToEvent("2025-09-15"), role: "production_lead", fields: { details: "Send a calendar invite to finalize the run of show with the worship leaders, then meet to lock it in." } },
  { title: "Walk worship leaders through the run of show", offsetDays: daysToEvent("2025-09-17"), role: "production_lead", fields: { details: "Send the meeting invite, introduce them to the team, share Public Worship's story and mission, go through the run of show, and take questions." } },
  { title: "Create the guest survey", offsetDays: daysToEvent("2025-09-16"), role: "comms_lead", fields: { details: "Build a QR-linked survey, display it at the end of the event, and fold in a link to give." } },
  { title: "Run an event walkthrough", offsetDays: daysToEvent("2025-09-18"), role: "production_lead", fields: { details: "Practice-run the day: setup, run of show, and teardown." } },
  { title: "Day-of coordination", offsetDays: 0, role: "logistics_lead", fields: { details: "Stock water and tissues, get everyone on site early, run setup, and run teardown." } },
  { title: "Post-event recap", offsetDays: daysToEvent("2025-09-22"), role: "comms_lead", fields: { details: "Recap what happened, thank everyone who showed up, and capture lessons learned." } },
];

// ── Comms & Content Schedule (comms) ────────────────────────────────────────
export const LTN_COMMS: ItemRow[] = [
  { title: "Story hook post (faceless / testimony style)", offsetDays: -12, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
  { title: "Countdown post — 10 days out", offsetDays: -10, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
  { title: "Schedule intro meeting with guest worship leaders", offsetDays: -9, role: "comms_lead", fields: { channel: ["audience_preferred"], audience: ["musicians"] } },
  { title: "Announce the first confirmed worship leader", offsetDays: -9, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"], notes: "Short video announcement." } },
  { title: "Engagement post referencing a past worship set", offsetDays: -8, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"], notes: "Optional — padding for engagement between announcements." } },
  { title: "Hold the volunteer expectations meeting", offsetDays: -7, role: "comms_lead", fields: { channel: ["imessage_group"], audience: ["volunteers"] } },
  { title: "Send volunteer expectations recap", offsetDays: -7, role: "comms_lead", fields: { channel: ["imessage_group"], audience: ["volunteers"], notes: "Send right after the expectations meeting." } },
  { title: "Announce a supporting worship act", offsetDays: -7, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"], notes: "Short video announcement." } },
  { title: "Engagement post (padding)", offsetDays: -5, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"], notes: "Optional — padding for engagement between announcements." } },
  { title: "Announce the closing worship leader", offsetDays: -3, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"], notes: "Short video announcement." } },
  { title: "Remind worship leaders to arrive early", offsetDays: -3, role: "comms_lead", fields: { channel: ["imessage_group"], audience: ["musicians"] } },
  { title: "Spiritual reminder to the team", offsetDays: -3, role: "comms_lead", fields: { channel: ["imessage_group", "team_slack"], audience: ["leaders", "volunteers"] } },
  { title: "Announce full lineup to RSVP'd guests", offsetDays: -3, role: "comms_lead", fields: { channel: ["partiful_posh"], audience: ["attendees"] } },
  { title: "Volunteer penultimate reminder", offsetDays: -1, role: "comms_lead", fields: { channel: ["imessage_group", "team_slack"], audience: ["volunteers"], notes: "Cover call time + what's expected." } },
  { title: "\"Tomorrow is the event\" post", offsetDays: -1, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
  { title: "Location + how-to-find-us post", offsetDays: 0, role: "comms_lead", fields: { channel: ["partiful_posh", "ig_stories"], audience: ["attendees", "general_public"], notes: "Quick phone video — where to park, where to enter." } },
  { title: "Volunteer final reminder", offsetDays: 0, role: "comms_lead", fields: { channel: ["imessage_group"], audience: ["volunteers"] } },
  { title: "Thank-you to volunteers", offsetDays: 1, role: "comms_lead", fields: { channel: ["imessage_group"], audience: ["volunteers"] } },
  { title: "Thank-you to worship leaders", offsetDays: 1, role: "comms_lead", fields: { channel: ["imessage_group"], audience: ["musicians"] } },
  { title: "Thank-you to attendees", offsetDays: 1, role: "comms_lead", fields: { channel: ["partiful_posh"], audience: ["attendees"], notes: "Include the giving-link reminder." } },
  { title: "Feedback survey nudge", offsetDays: 3, role: "comms_lead", fields: { channel: ["partiful_posh", "imessage_group"], audience: ["attendees", "volunteers"] } },
];

// ── Run of Show (minute offsets from the 3:45 PM welcome/worship start) ─────
export const LTN_RUN_OF_SHOW: ItemRow[] = [
  { title: "Welcome-area décor placement", offsetMinutes: minsFromStart("2025-09-20T12:00:00"), role: "logistics_lead", fields: { duration: 30, notes: "Set the welcome/hospitality area: tables, tablecloths, flowers, candles." } },
  { title: "Sound setup", offsetMinutes: minsFromStart("2025-09-20T12:30:00"), role: "production_lead", fields: { duration: 60, notes: "Production vendor + helping hands load in and set up sound." } },
  { title: "Sound check", offsetMinutes: minsFromStart("2025-09-20T13:30:00"), role: "production_lead", fields: { duration: 30, notes: "With the worship leaders and production vendor; keep an eye on anything nearby (foot traffic, permit windows) that could shift timing." } },
  { title: "Team huddle", offsetMinutes: minsFromStart("2025-09-20T14:00:00"), role: "event_lead", fields: { duration: 10, notes: "Whole team huddle before doors." } },
  { title: "Worship ambiance begins (stage prep + playlist)", offsetMinutes: minsFromStart("2025-09-20T14:10:00"), role: "comms_lead", fields: { duration: 20, notes: "Ambient playlist starts as final stage prep happens." } },
  { title: "Distribute flowers to arriving guests", offsetMinutes: minsFromStart("2025-09-20T14:30:00"), role: "comms_lead", fields: { duration: 10, notes: "Hand roses/daisies to arriving guests as an icebreaker." } },
  { title: "Flower-exchange icebreaker", offsetMinutes: minsFromStart("2025-09-20T14:40:00"), role: "comms_lead", fields: { duration: 60, notes: "Prompt guests to trade flowers and swap stories with someone new." } },
  { title: "Welcome + invitation to worship", offsetMinutes: 0, role: "event_lead", fields: { duration: 5, notes: "Welcome the crowd, introduce the event, invite people to posture their hearts for worship." } },
  { title: "Opening prayer", offsetMinutes: 5, role: "event_lead", fields: { duration: 5, notes: "Host hands off to open in prayer." } },
  { title: "Worship set 1", offsetMinutes: 10, role: "production_lead", fields: { duration: 35, notes: "First guest worship leader + band." } },
  { title: "Worship set 2", offsetMinutes: 45, role: "production_lead", fields: { duration: 45, notes: "Second guest worship leader + band." } },
  { title: "Love Thy Neighbor segment + call to follow Jesus", offsetMinutes: 90, role: "event_lead", fields: { duration: 10, notes: "Transition moment — invitation to follow Jesus, before the closing band takes the stage." } },
  { title: "Worship set 3", offsetMinutes: 100, role: "production_lead", fields: { duration: 35, notes: "Closing guest worship leader + band." } },
  { title: "Closing remarks + giving + next event", offsetMinutes: 135, role: "event_lead", fields: { duration: 10, notes: "Vote of thanks, highlight volunteers, next-event invitation, giving call, closing prayer." } },
  { title: "Close + food service", offsetMinutes: 145, role: "logistics_lead", fields: { duration: 20, notes: "Open food service as the event wraps and begin teardown." } },
];

// ── Crew expectations (volunteer_expectations) ──────────────────────────────
export const LTN_VOLUNTEER: ItemRow[] = [
  { title: "Set up florals + welcome décor before doors", fields: { team: "welcome", details: "Dress the welcome area — florals, visual elements, and any table setup — before guests start arriving." } },
  { title: "Greet guests at each approach + guide them in", fields: { team: "welcome", details: "Be visible and warm at every entry point; welcome people in and walk them toward the gathering area so the flow stays smooth." } },
  { title: "Run the flower-exchange icebreaker", fields: { team: "welcome", details: "Distribute flowers to arriving guests and prompt them to trade with someone new and share a quick story." } },
  { title: "Hand out meal tickets for completed surveys", fields: { team: "welcome", details: "Offer a meal ticket to any guest who completes the event survey." } },
  { title: "Hold Giving Moment QR cards when cued", fields: { team: "welcome", details: "On the host's cue, hold up the printed giving QR cards; if asked, keep the pitch simple and low-pressure." } },
  { title: "Set up the prayer station", fields: { team: "prayer", details: "Set up signage, seating, and water/tissues at the prayer station before doors." } },
  { title: "Welcome guests to the prayer station", fields: { team: "prayer", details: "Greet anyone who comes to the prayer station, ask what they'd like prayer for, and match them with an available team member." } },
  { title: "Pray with anyone who asks", fields: { team: "prayer", details: "Keep it brief and gentle; always ask consent before any physical contact (like a hand on the shoulder)." } },
  { title: "Field deeper questions about Jesus", fields: { team: "prayer", details: "Take theology questions as they come; if a conversation runs long, step a few feet aside so the line keeps moving." } },
  { title: "Keep every conversation confidential", fields: { team: "prayer", details: "Speak softly and never repeat what someone shared in prayer." } },
  { title: "Coordinate stage transitions between worship sets", fields: { team: "production", details: "Cue each worship leader on/off stage, manage mic handoffs, and keep transitions tight between sets." } },
];

// ── Permits ──────────────────────────────────────────────────────────────
export const LTN_PERMITS: ItemRow[] = [
  { title: "Parks & Recreation permit", offsetDays: -11, role: "event_lead", status: "to_apply", fields: { jurisdiction: "City Parks & Recreation Dept.", notes: "Required for any public outdoor gathering in a park. This is the long pole — apply as early as possible." } },
  { title: "Amplified sound permit", offsetDays: -11, role: "event_lead", status: "to_apply", fields: { jurisdiction: "Local police precinct", notes: "Apply alongside the park permit; typically issued by a precinct officer a few days before the event." } },
];

// ── Supplies & Logistics ────────────────────────────────────────────────────
export const LTN_SUPPLIES: ItemRow[] = [
  { title: "QR-code giving cards", offsetDays: -14, role: "logistics_lead", status: "need_to_order", fields: { source: "order_online", notes: "Double-sided: donate link on one side, event info on the other. Order enough for a large crowd plus a few oversized versions for signage." } },
  { title: "Prayer / come-worship signage", offsetDays: -14, role: "logistics_lead", status: "need_to_order", fields: { source: "order_online", qty: 8, notes: "\"Need prayer?\" on one side, an invite (\"Love thy neighbor\", \"Free concert\", etc.) on the other — vary the wording across signs." } },
  { title: "Standing sign for the prayer team", offsetDays: -14, role: "logistics_lead", status: "need_to_order", fields: { source: "order_online", qty: 1 } },
  { title: "Volunteer shirts / merch", offsetDays: -14, role: "logistics_lead", status: "need_to_order", fields: { source: "order_online" } },
  { title: "Pop-up stand for the prayer station", offsetDays: -14, role: "logistics_lead", status: "need_to_order", fields: { source: "order_online", qty: 1 } },
  { title: "Welcome-area décor: tables, cloths, flowers, candles", offsetDays: -1, role: "logistics_lead", status: "pull_from_storage", fields: { container: "tbd", notes: "Pull the night before if flowers/candles need same-day freshness." } },
];

export const LTN_RETRO: ItemRow[] = [
  { title: "What went well?", status: "open" },
];

export const LTN_ROWS_BY_MODULE: Record<ModuleKey, ItemRow[]> = {
  planning_doc: LTN_PLANNING,
  comms: LTN_COMMS,
  run_of_show: LTN_RUN_OF_SHOW,
  volunteer_expectations: LTN_VOLUNTEER,
  supplies: LTN_SUPPLIES,
  permits: LTN_PERMITS,
  retro: LTN_RETRO,
};
```

**c. Run the full suite before moving on:**
`cd apps/convex && pnpm vitest run tests/loveThyNeighborTemplate.test.ts` —
all 4 tests pass. Then `pnpm typecheck` (root) to confirm the new file type-
checks cleanly (in particular, that every `fields.channel`/`fields.audience`/
`fields.source`/`fields.team` string is a valid member of its option set —
`fields` is typed as `Record<string, unknown>` on `ItemRow`, so this won't be
caught by the compiler; instead cross-check every value used above against
`COMMS_CHANNEL_OPTIONS`, `COMMS_AUDIENCE_OPTIONS`, `SUPPLY_SOURCE_OPTIONS`,
`VOLUNTEER_TEAM_OPTIONS`, `SUPPLY_STATUS_OPTIONS`, `PERMIT_STATUS_OPTIONS` in
`packages/shared/src/index.ts` by hand — they are already cross-checked in
this plan, but re-verify if any row is edited during implementation).

### 2. Wire LTN into `buildChapterRolesAndTemplates` (`apps/convex/lib/seed/templates.ts`)

**a. RED.** Add these two imports to the top of
`apps/convex/tests/loveThyNeighborTemplate.test.ts` (alongside the Step 1
imports — one import block per module at the top of the file, not repeated
mid-file):

```ts
import { newT, run, setupChapter } from "./setup.helpers";
import { buildChapterRolesAndTemplates } from "../lib/seed/templates";
```

Then append this `describe` block to the end of the file:

```ts
describe("buildChapterRolesAndTemplates — Love Thy Neighbor", () => {
  test("LTN gets its own roles + items, independent of Eden", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);

    const { edenId, ltnId } = await run(t, (ctx) =>
      buildChapterRolesAndTemplates(ctx, chapterId, userId, Date.now()),
    );

    const ltn = await run(t, (ctx) => ctx.db.get(ltnId));
    expect(ltn?.deriveFromEventTypeId).toBeUndefined();

    const [edenRoles, ltnRoles] = await Promise.all([
      run(t, (ctx) =>
        ctx.db.query("templateRoles").withIndex("by_template", (q) => q.eq("eventTypeId", edenId)).collect(),
      ),
      run(t, (ctx) =>
        ctx.db.query("templateRoles").withIndex("by_template", (q) => q.eq("eventTypeId", ltnId)).collect(),
      ),
    ]);
    // Same 4 role keys, but distinct rows (own ids, not shared with Eden).
    expect(ltnRoles.map((r) => r.key).sort()).toEqual(edenRoles.map((r) => r.key).sort());
    expect(new Set(ltnRoles.map((r) => r._id))).not.toEqual(new Set(edenRoles.map((r) => r._id)));

    const ltnPlanningItems = await run(t, (ctx) =>
      ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) => q.eq("eventTypeId", ltnId).eq("module", "planning_doc"))
        .collect(),
    );
    // LTN's own 20-row Tasks list, not Eden's 10.
    expect(ltnPlanningItems.length).toBe(20);
  });
});
```

Run `cd apps/convex && pnpm vitest run tests/loveThyNeighborTemplate.test.ts`
and confirm the last assertion fails: today `ltnPlanningItems.length` is `10`
(Eden's row count, because LTN currently clones Eden's items), not `20`. This
is a genuine RED — the current behavior really does produce Eden's count.

**b. GREEN.** In `apps/convex/lib/seed/templates.ts`:

Add the import (alongside the existing `PERMIT_ROWS`/`VOLUNTEER_ROWS`/
`RETRO_ROWS` literals, near the top of the file):

```ts
import { LTN_DESCRIPTION, LTN_ROWS_BY_MODULE } from "./loveThyNeighbor";
```

Replace the entire "── Love Thy Neighbor (derived from Eden — same structure)
──" block (currently lines 1193-1242 — the `eventTypes` insert with
`deriveFromEventTypeId: edenId` followed by the three clone loops over
`edenRoles`/`edenCols`/`edenItems`) with:

```ts
  // ── Love Thy Neighbor (own content — outdoor neighborhood block party) ─────
  const ltnId = (await ctx.db.insert("eventTypes", {
    chapterId,
    name: "Love Thy Neighbor",
    slug: toSlug("Love Thy Neighbor"),
    description: LTN_DESCRIPTION,
    disabledCoreModules: [],
    version: 1,
    isArchived: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  })) as Id<"eventTypes">;

  const ltnRoleByKey = await seedTemplateRoles(ctx, ltnId, DEFAULT_ROLES);

  for (const m of GRID_CORE_MODULE_KEYS) {
    await seedTemplateCols(ctx, ltnId, m);
  }

  for (const [module, rows] of Object.entries(LTN_ROWS_BY_MODULE)) {
    await addTemplateItems(ctx, ltnId, module as ModuleKey, rows, ltnRoleByKey);
  }
```

Leave the function's return statement (`return { edenId, ltnId, wwsId };`) and
the Worship With Strangers block below it untouched — WWS still derives from
Eden exactly as before; only LTN's construction changes.

**c. Run the full suite before moving on:**
`cd apps/convex && pnpm vitest run tests/loveThyNeighborTemplate.test.ts` —
all tests in the file pass. Then `cd apps/convex && pnpm test` (full backend
suite) to confirm nothing else that reads `eventTypes`/`templateItems` for a
freshly-bootstrapped chapter (e.g. any test that calls `ensureChapters`,
`seedDemoData`, or `buildChapterRolesAndTemplates` directly) broke on LTN's
new row counts or the missing `deriveFromEventTypeId`.

### 3. Add the prod-upgrade mutation (`apps/convex/seed.ts`)

**a. RED.** Add this import to the top of
`apps/convex/tests/loveThyNeighborTemplate.test.ts` (same top import block as
before):

```ts
import { internal } from "../_generated/api";
```

Then append this `describe` block to the end of the file:

```ts
describe("seed.upgradeLoveThyNeighborTemplate", () => {
  test("replaces an existing chapter's stale LTN content in place, preserving its id", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);

    // Simulate prod's pre-migration state: an Eden-derived LTN stub with a
    // stale role/item shape (no LTN-specific content).
    const staleLtnId = await run(t, async (ctx) => {
      const now = Date.now();
      const edenId = await ctx.db.insert("eventTypes", {
        chapterId, name: "Eden", slug: "eden", disabledCoreModules: [],
        version: 1, isArchived: false, createdBy: userId, createdAt: now, updatedAt: now,
      });
      const ltnId = await ctx.db.insert("eventTypes", {
        chapterId, name: "Love Thy Neighbor", slug: "love-thy-neighbor",
        deriveFromEventTypeId: edenId, disabledCoreModules: [],
        version: 1, isArchived: false, createdBy: userId, createdAt: now, updatedAt: now,
      });
      const roleId = await ctx.db.insert("templateRoles", {
        eventTypeId: ltnId, key: "event_lead", label: "Event Lead / PM", order: 0, isArchived: false,
      });
      await ctx.db.insert("templateItems", {
        eventTypeId: ltnId, module: "planning_doc", title: "Stale Eden-clone row", order: 0, roleId,
      });
      return ltnId;
    });

    const result = await t.mutation(internal.seed.upgradeLoveThyNeighborTemplate, {
      chapterId,
      createdBy: userId,
    });

    expect(result.eventTypeId).toBe(staleLtnId); // same document, patched in place
    expect(result.replaced).toBe(true);

    const ltn = await run(t, (ctx) => ctx.db.get(staleLtnId));
    expect(ltn?.deriveFromEventTypeId).toBeUndefined();

    const items = await run(t, (ctx) =>
      ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) => q.eq("eventTypeId", staleLtnId).eq("module", "planning_doc"))
        .collect(),
    );
    expect(items.some((i) => i.title === "Stale Eden-clone row")).toBe(false);
    expect(items.length).toBe(20);

    // Idempotent: running it again doesn't duplicate rows.
    await t.mutation(internal.seed.upgradeLoveThyNeighborTemplate, { chapterId, createdBy: userId });
    const itemsAfterSecondRun = await run(t, (ctx) =>
      ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) => q.eq("eventTypeId", staleLtnId).eq("module", "planning_doc"))
        .collect(),
    );
    expect(itemsAfterSecondRun.length).toBe(20);
  });

  test("creates LTN fresh when the chapter has none yet", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);

    const result = await t.mutation(internal.seed.upgradeLoveThyNeighborTemplate, {
      chapterId,
      createdBy: userId,
    });

    expect(result.replaced).toBe(false);
    const ltn = await run(t, (ctx) => ctx.db.get(result.eventTypeId));
    expect(ltn?.name).toBe("Love Thy Neighbor");
  });
});
```

Run `cd apps/convex && pnpm vitest run tests/loveThyNeighborTemplate.test.ts`
and confirm this fails: `internal.seed.upgradeLoveThyNeighborTemplate` does
not exist yet (a genuine RED — the registered function is missing).

**b. GREEN.** In `apps/convex/seed.ts`, add the import immediately after the
existing `FIELD_DAY_*` import block (currently lines 50-56, `import {
FIELD_DAY_COMMS, ... } from "./lib/seed/fieldDay";`) — every other symbol this
mutation needs (`ConvexError`, `v`, `ModuleKey`, `toSlug`, `seedTemplateRoles`,
`Id`, `internalMutation`, `MutationCtx`, `DEFAULT_ROLES`,
`GRID_CORE_MODULE_KEYS`, `seedTemplateCols`, `addTemplateItems`) is already
imported at the top of this file:

```ts
import { LTN_DESCRIPTION, LTN_ROWS_BY_MODULE } from "./lib/seed/loveThyNeighbor";
```

and add this mutation directly after `fieldDayTemplate`:

```ts
/**
 * Upsert the "Love Thy Neighbor" template's content for a chapter that was
 * already bootstrapped before this content existed — `ensureChapters` is a
 * no-op once a chapter's row exists, so it can never pick up a content-only
 * change to `buildChapterRolesAndTemplates`. If the chapter already has a
 * "Love Thy Neighbor" `eventTypes` row (e.g. today's Eden-derived stub), it
 * is PATCHED IN PLACE — its id is preserved and only its child rows
 * (roles/columns/items) are replaced — so any event already created from it
 * keeps working (`instantiateEvent` deep-copies at creation time; nothing
 * re-reads the template afterward). If the chapter has none, one is created.
 *
 * Idempotent: safe to re-run. Runnable with
 * `npx convex run seed:upgradeLoveThyNeighborTemplate` (add `--prod` to
 * target production). Defaults to the first chapter/user; pass
 * `chapterId`/`createdBy` to target a specific one.
 *
 * SECURITY: `internalMutation` — no auth, bulk-writes template data, not
 * called from the UI. Dashboard/CLI only.
 */
export const upgradeLoveThyNeighborTemplate = internalMutation({
  args: {
    chapterId: v.optional(v.id("chapters")),
    createdBy: v.optional(v.id("users")),
  },
  handler: async (ctx: MutationCtx, args) => {
    const chapter = args.chapterId
      ? await ctx.db.get(args.chapterId)
      : await ctx.db.query("chapters").first();
    if (!chapter)
      throw new ConvexError({
        code: "NO_CHAPTER",
        message: "No chapter found — pass chapterId explicitly.",
      });
    const user = args.createdBy
      ? await ctx.db.get(args.createdBy)
      : await ctx.db.query("users").first();
    if (!user)
      throw new ConvexError({
        code: "NO_USER",
        message: "No user found — pass createdBy explicitly.",
      });

    const now = Date.now();
    const slug = toSlug("Love Thy Neighbor");
    const existing = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter_slug", (q) =>
        q.eq("chapterId", chapter._id).eq("slug", slug),
      )
      .first();

    let eventTypeId: Id<"eventTypes">;
    if (existing) {
      await ctx.db.patch(existing._id, {
        description: LTN_DESCRIPTION,
        deriveFromEventTypeId: undefined,
        disabledCoreModules: [],
        updatedAt: now,
      });
      eventTypeId = existing._id;
      for (const table of ["templateItems", "templateColumns", "templateRoles"] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex("by_eventType" as never, (q: any) => q.eq("eventTypeId", eventTypeId))
          .collect();
        for (const row of rows) await ctx.db.delete(row._id);
      }
    } else {
      eventTypeId = (await ctx.db.insert("eventTypes", {
        chapterId: chapter._id,
        name: "Love Thy Neighbor",
        slug,
        description: LTN_DESCRIPTION,
        disabledCoreModules: [],
        version: 1,
        isArchived: false,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      })) as Id<"eventTypes">;
    }

    const roleIdByKey = await seedTemplateRoles(ctx, eventTypeId, DEFAULT_ROLES);
    for (const m of GRID_CORE_MODULE_KEYS) {
      await seedTemplateCols(ctx, eventTypeId, m);
    }
    let itemsInserted = 0;
    for (const [module, rows] of Object.entries(LTN_ROWS_BY_MODULE)) {
      await addTemplateItems(ctx, eventTypeId, module as ModuleKey, rows, roleIdByKey);
      itemsInserted += rows.length;
    }

    return { eventTypeId, chapter: chapter.name, replaced: !!existing, itemsInserted };
  },
});
```

Note: `templateRoles` uses index name `by_template`, not `by_eventType` —
either write the delete loop as three separate blocks each naming its real
index (`templateRoles` → `by_template`, `templateColumns` → `by_eventType`,
`templateItems` → `by_eventType`), which is clearer than the `as never` cast
above and matches this codebase's preference for explicit, readable Convex
queries over cleverness — prefer that form:

```ts
      const roles = await ctx.db.query("templateRoles").withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId)).collect();
      const columns = await ctx.db.query("templateColumns").withIndex("by_eventType", (q) => q.eq("eventTypeId", eventTypeId)).collect();
      const items = await ctx.db.query("templateItems").withIndex("by_eventType", (q) => q.eq("eventTypeId", eventTypeId)).collect();
      for (const row of [...roles, ...columns, ...items]) await ctx.db.delete(row._id);
```

Use this explicit form instead of the generic-table-name loop shown in the
test-driving sketch above.

**c. Run the full suite before moving on:**
`cd apps/convex && pnpm vitest run tests/loveThyNeighborTemplate.test.ts` —
all tests pass. Then run the full validation suite (final step, next).

### 4. Final validation
Run every command in Validation Commands below and confirm all exit clean.

## Testing Strategy

### Tests by Milestone
| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | Ported seed data (`loveThyNeighbor.ts`) | `apps/convex/tests/loveThyNeighborTemplate.test.ts` | Every row's `role` is a real `DEFAULT_ROLES` key; `LTN_ROWS_BY_MODULE` covers all 7 modules with the matching arrays; `LTN_PLANNING.length > 10`; `LTN_DESCRIPTION` doesn't mention Eden | The module doesn't exist — import fails |
| 2 | LTN wired into `buildChapterRolesAndTemplates` | same file | `ltn.deriveFromEventTypeId` is undefined; LTN's roles are distinct rows from Eden's (same keys, different ids); LTN's `planning_doc` item count is 20 | LTN currently clones Eden: `deriveFromEventTypeId` is set, roles/items are literal copies, and `planning_doc` count is Eden's 10 |
| 3 | `seed.upgradeLoveThyNeighborTemplate` | same file | Given a stale Eden-derived LTN stub, the mutation patches the SAME `eventTypes._id`, clears `deriveFromEventTypeId`, replaces its items (old row gone, 20 new `planning_doc` rows), and is idempotent (re-run doesn't duplicate); given no existing LTN, it creates one fresh | The mutation doesn't exist yet |

**Pattern followed:** `apps/convex/tests/templateClone.test.ts` (the
`run(t, ...)`/`setupChapter`/index-query conventions) and
`apps/convex/tests/importRoster.test.ts` (the `t.mutation(internal.seed.x,
{})` pattern for invoking a `seed.ts` internal mutation from a test).

### Integration Tests
N/A beyond the milestone tests above — there is no UI change; the existing
grid/event-item rendering code already works off `templateItems` rows
generically (proven by Eden/WWS/Field Day already exercising the same code
path). The milestone 2 and 3 tests already exercise the real
`buildChapterRolesAndTemplates`/`seed.ts` seams, not mocks.

### Edge Cases
- **A role key typo silently drops the owner** (`roleIdByKey[r.role]` returns
  `undefined` on a miss, no throw) — covered by milestone 1's "every row's
  role key is a real DEFAULT_ROLES key" test.
- **Re-running the prod upgrade mutation** (operator re-runs it, or a retry
  after a partial failure) must not duplicate rows — covered by milestone 3's
  idempotency assertion.
- **Chapter with no existing LTN row at all** (a brand-new chapter created
  after this PR ships, before `ensureChapters`/`buildChapterRolesAndTemplates`
  ever runs for it, then someone runs the upgrade mutation anyway) — covered
  by milestone 3's "creates LTN fresh" test.
- **WWS must be unaffected** — milestone 2's test only asserts on `edenId`/
  `ltnId`; running the full backend suite (`cd apps/convex && pnpm test`)
  after milestone 2 catches any accidental regression to the WWS block below
  it, since WWS's own `deriveFromEventTypeId: edenId` and item counts are
  unchanged by this plan.

## Acceptance Criteria
- [ ] `apps/convex/lib/seed/loveThyNeighbor.ts` exists with `LTN_PLANNING`,
      `LTN_COMMS`, `LTN_RUN_OF_SHOW`, `LTN_VOLUNTEER`, `LTN_PERMITS`,
      `LTN_SUPPLIES`, `LTN_RETRO`, `LTN_ROWS_BY_MODULE`, `LTN_DESCRIPTION` as
      specified.
- [ ] `buildChapterRolesAndTemplates` no longer sets `deriveFromEventTypeId`
      on LTN and no longer clones Eden's roles/columns/items onto it; LTN's
      `planning_doc` module has 20 items after a fresh chapter bootstrap.
- [ ] `apps/convex/seed.ts` exports `upgradeLoveThyNeighborTemplate`, an
      `internalMutation` that upserts LTN content for an existing chapter,
      preserving the `eventTypes._id` when one already exists, and is
      idempotent.
- [ ] No row in any `LTN_*` array references a role key outside
      `event_lead`/`comms_lead`/`logistics_lead`/`production_lead`.
- [ ] No row contains a real person's name, a specific vendor name, or a
      dollar amount carried over from the 2025 event (per the "generic,
      reusable template" requirement).
- [ ] `apps/convex/tests/loveThyNeighborTemplate.test.ts` passes, and the full
      `pnpm test` suite has zero regressions.
- [ ] Eden's and Worship With Strangers's own seed content/row counts are
      unchanged.

## Validation Commands
Execute every command. Every one must exit clean.

- `cd apps/convex && pnpm vitest run tests/loveThyNeighborTemplate.test.ts` — fast, targeted (~0.6s)
- `pnpm test` — full suite (turbo → 3 packages), zero regressions
- `pnpm typecheck` — `tsc --noEmit` × 3 packages
- `pnpm lint` — zero new errors (pre-existing 97 mobile warnings are expected, not from this change)
- `pnpm build` — web bundle export still succeeds

## Notes
- No new dependencies.
- No schema change — `eventTypes`/`templateItems`/`templateRoles`/
  `templateColumns` already have every field this plan needs.
- No Academy update — see Scope's "Out of scope" for the grep that confirms
  no lesson describes LTN's template structure or its Eden-derivation.
- Deliberately deferred: actually invoking
  `npx convex run seed:upgradeLoveThyNeighborTemplate --prod` against the live
  `vivid-rhinoceros-688` deployment. Per the Agent Delivery Workflow, ship
  this as a normal PR (branch → PR → review → CI green → squash-merge); running
  the prod data mutation is a separate, explicit follow-up action to confirm
  with the user before executing (it bulk-writes production template data).
- The exact wording of every ported row (task titles, comms copy, run-of-show
  notes, crew-expectation instructions) is a judgment call made in this plan
  from the source Notion doc, genericized per the user's explicit instruction
  to drop real names/amounts and infer role ownership. If the user wants any
  row's wording adjusted after reviewing the PR diff, that's a fast follow-up
  edit to `apps/convex/lib/seed/loveThyNeighbor.ts` — no structural rework
  needed.
