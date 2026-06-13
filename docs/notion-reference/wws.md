# Worship With Strangers (WWS) — Notion Template Reference

Source: Notion HTML+CSV export of **"Worship With Strangers (Please Make a Copy)"** — the
**lightweight / trimmed** variant of the full **Eden** event plan. Captured for faithful seeding.

The export is a single Notion page ("workspace") containing 6 child sub-pages. Two of those
sub-pages embed a Notion **database** (collection) at their top, others are plain docs or static
tables. Property **types** were recovered from the per-column icon SVG (e.g. `icons/calendar_gray.svg`
= date). Select/Status **option colors** were recovered from CSS classes (`select-value-color-*`,
`status-dot-color-*`).

## Top-Level Page

- Title: **Worship With Strangers (Please Make a Copy)**
- Intro callout: "Duplicate this page for each new event, then fill in the placeholders… Rename the page + update dates/location… Duplicate/rename the subpages in 'Quick Links'."
- **Overview** block (free-text placeholders, NOT a database):
  - Project Name: `[EVENT NAME]`
  - Type: `Event`
  - Location: `[NEIGHBORHOOD / VENUE]`
  - Event Date: `@September 26, 2026` (placeholder date)
  - Deadline: `@` (empty)
  - Project Description: What it is / Why it matters / What people experience / Digital audience — all placeholder prose.
- **Quick Links** to the 6 sub-pages (see database inventory below).

---

## Database / Sub-page Inventory

| # | Sub-page | Kind | Rows | Cols | Notes |
|---|----------|------|-----:|-----:|-------|
| 1 | WWS - Planning Doc (TEMPLATE) | Page hosting **2 databases** (Event Settings + Event Planning Tasks) | — | — | See below |
| 1a | → Event Settings | **Database** | 1 | 3 | The "event config" table |
| 1b | → Event Planning Tasks | **Database** | 20 (19 real + 1 blank spacer) | 10 | The core task list |
| 2 | WWS - Comms & Content Schedule | **Database** | 11 | 9 | Comms plan |
| 3 | WWS – Supplies & Packing Checklist | **Database** | 17 (16 real + 1 blank spacer) | 5 | Gear list |
| 4 | WWS - Run of Show (TEMPLATE) | **Static `simple-table`** (NOT a database) | 7 | 4 | Minute-by-minute flow |
| 5 | WWS - Permits (TEMPLATE) | **Empty page** | 0 | 0 | Title only, no body |
| 6 | WWS - Retrospective (TEMPLATE) | **Empty page** | 0 | 0 | Title only, no body |

**Databases present:** Event Settings, Event Planning Tasks, Comms & Content Schedule, Supplies & Packing Checklist (4 true databases).
**Databases absent / stubbed:** Permits and Retrospective exist as titled pages but are **completely empty** (no columns, no rows, no body). Run of Show is a static table, not a database.

---

## 1a. Event Settings (Database)

The lightweight "event config" — a single row that all Planning Tasks relate to.

### Columns

| Column | Type | Notes |
|--------|------|-------|
| Event | text (title) | Title property. Value: `WWS` |
| Budget | number → **currency** | Rendered as `$300.00` (USD currency formatting) |
| Event Date | date | `June 27, 2026` |

> NOTE: the CSV for Event Settings shows `Budget` before `Event Date`; the HTML header order is `Event, Event Date, Budget`. Treat Budget as currency-formatted number.

### Rows

| Event | Budget | Event Date |
|-------|--------|-----------|
| WWS | $300.00 | June 27, 2026 |

The sub-page body for the `WWS` row is empty (no rich content).

---

## 1b. Event Planning Tasks (Database)

The core task list. Each task **relates** to the Event Settings row and **rolls up** its date.

### Columns

| Column | Type | Notes / Options |
|--------|------|-----------------|
| Task | text (title) | Title property |
| Details | long-text | Multi-line; bullet lists, embedded Notion links, `TODO @person` mentions |
| Status | **status** | Single observed option: **Not started** (red dot). Status-type property (`burst` icon). |
| Offset (days) | text | Stored as free text like `T-14`, `T-12`, `T-10`, `T-7`, `T-1`, `T+1`. NOT a number/formula — plain text. CSV header is literally `Offset (days)`. |
| Due Date (Dont Edit) | **formula** | Computed (Event Date + offset). Empty in export (formula not materialized in CSV). |
| Role | **select** | Options w/ colors: **Events Lead** (purple), **Comms Lead** (pink), **Production Lead** (orange), **Logistics Lead** (green) |
| Owner | **person** | Empty across all rows (no people assigned in template) |
| Notes | long-text | Empty across all rows |
| Event | **relation** → Event Settings | Title cell links to `Event Settings/WWS`. Every row points to the single `WWS` event. |
| Event Date | **rollup/lookup** | `search` icon = rollup from related Event. Value `June 27, 2026` mirrored onto every row. |

### Rows (19 real tasks; Status = "Not started" for all)

| Task | Role | Offset | Details (summary) |
|------|------|--------|-------------------|
| Highlight Plans in Monthly Team meeting | Events Lead | — | When is WWS happening; who's leading & where |
| Update Planning Template (This Document) | Events Lead | T-14 | Update the owners & communicate with them |
| Create posting schedule for this event | Comms Lead | T+1 | Update comms doc w/ posting schedule; work with marketing lead; links to Onboarding doc |
| Scout & confirm NYC filming locations | Events Lead | T-12 | Identify public spots, backups for weather/permits, optionally visit |
| Check permits + public-space rules (filming & amplified sound) | Events Lead | T-12 | Confirm amplified-sound & filming rules per location |
| Meet with Videographer to discuss content capture style | Production Lead | T-7 | Discuss deliverables; iPhone OK; Production+Marketing coordinate |
| Hire videographer + Editor for the event (Should be the same person) | Production Lead | T-10 | Budget $150; 3 short video deliverables; contact list TODO @Seyi Olujide |
| Get all items day before event | Logistics Lead | T-1 | Links to **Supplies & Packing Checklist** database |
| Assign someone to set up sound day of | Production Lead | T-10 | Confirm audio chain (mics, XLR, interface, speaker) + battery/power; links Busking Setup doc |
| Update comms schedule | Comms Lead | T-12 | Links to **Comms & Content Schedule** database |
| Bring water for worship leaders/band members, yourself, and volunteers | Logistics Lead | T-1 | From home or buy on location (Max $20) |
| *(blank spacer row)* | — | — | — |
| Choose worship leaders | Comms Lead | T-7 | Decide 1–2 leaders; comms→music lead; put names/numbers in notes; spontaneous worship ready |
| Choose Instrumentalists | Comms Lead | T-7 | Keyboard/Guitar/Cajon (optional); reach out, confirm, record contacts |
| Make sure battery is charged (VERY IMPORTANT) | Logistics Lead | T-1 | Take battery home to charge after pulling from storage |
| Update the Event Date in Event setting | Events Lead | T-14 | — |
| Send out song bank to vocalists & instrumentalists once confirmed | Comms Lead | T-7 | Songs aligned w/ PW Songwriting & Selection Philosophy; confirm music lead did this |
| Create slack (or gchat) thread in WWS channel/space | Events Lead | T-14 | Tag owners; format "WWS [Date] @Owner1, @Owner2 @Owner3" |
| Schedule group meeting with owners | Events Lead | — | All people mentioned in previous step |
| Order food for worship leaders/band members, yourself, and volunteers | Events Lead | — | Budget ~$20 per person. (No Event relation/date set on this row.) |

> Embedded cross-references in Details: links to external Notion docs "Onboarding - All Public Worship", "Busking Setup Electronics", "PW Songwriting & Song Selection Philosophy"; `TODO @Seyi Olujide`, `@juliechi__` mentions. Task sub-page bodies are all empty — the substance lives in the **Details** column.

---

## 2. Comms & Content Schedule (Database)

Internal CSV name is `Eden - Comms & Content Schedule` (the trimmed copy reused Eden's table).

### Columns

| Column | Type | Notes / Options |
|--------|------|-----------------|
| Comm Title | text (title) | Title property |
| Audience | **multi-select** | Options w/ colors: **General Public** (brown), **Attendees** (gray), **Leaders** (green), **Volunteers** (yellow) |
| Channel/Medium | **multi-select** | Options w/ colors: **IG Post** (pink), **IG Stories** (yellow), **iMessage Volunteer Group** (gray), **Team Slack** (red), **Audience Preferred** (blue), **Google Meet** (brown) |
| Date | **formula** | `formula` icon; in CSV materialized as e.g. `Sunday, May 24, 2026` |
| Days till event | text | Free text `T-7`, `T-0`, `T-1`, `T-3`, `T-5`, `T-11`, `T-12`, `T-13`, `T-14` |
| Files & media | **files/image** | Only 1 row has a file (the flyer image, see below) |
| Notes | long-text | Per-row message drafts / scripts |
| Owner | **person** | Empty across all rows |
| Status | **select** | Single observed option **Not started**. (Rendered as plain select, not status-dot.) |

### Rows (11)

| Comm Title | Audience | Channel/Medium | Date | Days till | Notes (summary) | Media |
|------------|----------|----------------|------|-----------|-----------------|-------|
| Announce Event on socials | General Public | IG Post, IG Stories | Sun May 24 2026 | T-7 | Announce Eden: worship outside the 4 walls + picnic vibe; date, borough, RSVP link; "This was a flyer." | **IMG_2214.jpeg** (flyer) |
| Location + how to find us (day-of) | Attendees, General Public, Leaders | IG Stories, iMessage Volunteer Group | Sun May 31 2026 | T-0 | Pin exact meet spot, what to look for, start time, what to bring | — |
| Day before reminder for iMessage group with call time | — | iMessage Volunteer Group | Sat May 30 2026 | T-1 | "Tomorrow's the day! …[motivational]" | — |
| Create iMessage group chat for team attending, videographers, worshippers, instrumentalists | Volunteers | iMessage Volunteer Group | Tue May 26 2026 | T-5 | "Hey everyone! excited to worship boldly in public in 3 days!…" | — |
| Send a reminder to be on time for leaders & musicians | — | Team Slack, iMessage Volunteer Group | Thu May 28 2026 | T-3 | Friendly reminder of location/time | — |
| Schedule meeting with event owners, with confirmed time that works for most | — | Audience Preferred, Team Slack | Tue May 19 2026 | T-12 | — | — |
| Send Meeting recap to all participants | Leaders | Team Slack | Tue May 26 2026 | T-5 | Where/what time + key discussion items | — |
| Reach out to music leader to confirm worship leaders & band | Leaders | Audience Preferred, Team Slack | Wed May 20 2026 | T-11 | Two-message script (confirm leader/band; brief on song guidelines + invite to meeting); links Onboarding doc | — |
| Ensure intro thread created for WWS | Leaders | Team Slack | Mon May 18 2026 | T-13 | New thread "WWS [Date] @Owner1, @Owner2, @Owner3" | — |
| D-day reminder for iMessage group with call time | — | Team Slack, iMessage Volunteer Group | Sun May 31 2026 | T-0 | Send re-cap of meeting to leaders | — |
| Reach out to Marketing team for flyer | Leaders | Audience Preferred, Team Slack | Sun May 17 2026 | T-14 | Flyer request script | — |
| Meet with event owners & worship leaders/instrumentalists | Leaders | Google Meet | Tue May 26 2026 | T-5 | Event lead owns this meeting; "what WWS is about" agenda | — |

> Rich content: the only embedded media in the whole export is **`IMG_2214.jpeg`** (an event flyer) attached to the "Announce Event on socials" row's `Files & media` property. That row's sub-page body itself is empty; the image is the property value. All other Comms sub-page bodies are empty.

---

## 3. Supplies & Packing Checklist (Database)

### Columns

| Column | Type | Notes / Options |
|--------|------|-----------------|
| Item | text (title) | Title property |
| Status | **status** | Single observed option **Pull from storage** (blue dot) |
| Source | **select** | Option: **Storage** (blue) |
| Packed in | **select** | Options: **Green luggage** (green), **On its Own** (yellow). Blank for a few items. |
| Notes | long-text | Empty across all rows |

### Rows (16 real items; all Status = "Pull from storage", Source = Storage)

| Item | Packed in |
|------|-----------|
| 2 x 1/4 inch to XLR Cable | Green luggage |
| Cajon/Sitting Drum (If Needed) | Green luggage |
| 2 x Shure SM58 Mics | Green luggage |
| Prayer standing sign | Green luggage |
| Guitar & cabling (If Needed) | Green luggage |
| 4 x XLR Cabling | Green luggage |
| Small table | Green luggage |
| Keyboard (If Needed) | Green luggage |
| Mixer | Green luggage |
| 2 x Church Came to you SIgns | Green luggage |
| 2 x QR Code Signs | Green luggage |
| 2 x Favorite worship song signs | Green luggage |
| 1 x Charged 200W Battery | Green luggage |
| 1 x ALTO 600W Speaker | On its Own |
| 2 x IEC Cable (Monitor Cable) | *(blank)* |
| Battery Charger | Green luggage |

> Despite the prompt's note that "each Supplies item has its own sub-page HTML file," every Supplies
> sub-page body is **empty** (0 chars, no images). The sub-pages exist only because each database
> row is also a Notion page; no rich content was authored. The `Untitled` HTML is the blank spacer row.

---

## 4. Run of Show (TEMPLATE) — Static Table (NOT a database)

A Notion `simple-table` (static, no column types/select options), preceded by free-text event-info
placeholders.

**Header block (placeholders):** Event Name `[EVENT NAME]`, Date `@`, Location `[PARK / ADDRESS]`,
Call Times: Setup `[TIME]` • Volunteers `[TIME]` • Team huddle `[TIME]` • Start `[TIME]`.

**Columns:** Time | Segment | Owner | Notes / Tech

| Time | Segment | Owner | Notes / Tech |
|------|---------|-------|--------------|
| [00:00] | Load-in / Setup | [Logistics Lead] | Power, stage area, FOH, camera positions |
| [00:00] | Soundcheck | [Production Lead] | Mic check, levels, track playback |
| [00:00] | Team huddle + Prayer | [Event Lead] | Pep talk, encouragement, have fun, truly worship |
| [00:00] | Worship set | [Worship Lead] | Song list, transitions, prayer moments |
| [00:00] | Gospel | [Worship Lead] | Give the gospel (sinners / deserved death / He took our place / cross / believe → life); invite to connect, follow, next event |
| [00:00] | Closing + next steps | [Event Lead] | Give gospel, invite to connect/follow/next event, end in prayer |
| [00:00] | Strike / Load-out | [Logistics Lead] | Leave no trace |

> Owner values reference roles via bracket placeholders (`[Logistics Lead]`, `[Production Lead]`,
> `[Event Lead]`, `[Worship Lead]`) — NOT a structured select. Note "Worship Lead" appears here but
> NOT in the Planning Tasks `Role` select (which has Events/Comms/Production/Logistics Lead).

---

## 5. Permits (TEMPLATE) — Empty

Titled page only. No body, no database, no rows. (In the full Eden plan this would be a permits
database; here it is a stub placeholder.)

## 6. Retrospective (TEMPLATE) — Empty

Titled page only. No body, no database, no rows. Stub placeholder.

---

## Type / Color Reference (union across all DBs)

| Notion type seen | Where | Color-coded options? |
|------------------|-------|----------------------|
| text (title) | every DB | n/a |
| long-text | Details, Notes | no |
| number / currency | Event Settings.Budget ($300.00) | n/a |
| date | Event Settings.Event Date | n/a |
| formula | Tasks.Due Date, Comms.Date | n/a (computed) |
| rollup/lookup | Tasks.Event Date | n/a |
| relation | Tasks.Event → Event Settings | n/a |
| status | Tasks.Status (red), Supplies.Status (blue) | yes (dot color) |
| select | Tasks.Role, Supplies.Source, Supplies.Packed in, Comms.Status | yes |
| multi-select | Comms.Audience, Comms.Channel/Medium | yes |
| person | Tasks.Owner, Comms.Owner (both empty) | n/a |
| files/image | Comms.Files & media (1 flyer) | n/a |

**Select/Status option color map**
- Role (Tasks): Events Lead=purple, Comms Lead=pink, Production Lead=orange, Logistics Lead=green
- Audience (Comms): General Public=brown, Attendees=gray, Leaders=green, Volunteers=yellow
- Channel/Medium (Comms): IG Post=pink, IG Stories=yellow, iMessage Volunteer Group=gray, Team Slack=red, Audience Preferred=blue, Google Meet=brown
- Source (Supplies): Storage=blue
- Packed in (Supplies): Green luggage=green, On its Own=yellow
- Status: Tasks="Not started"=red; Supplies="Pull from storage"=blue; Comms="Not started" (plain select)

---

## Trimming Story (WWS lightweight vs full Eden plan)

What's **lighter** in WWS:

1. **Two of six databases are empty stubs** — **Permits** and **Retrospective** are titled placeholder
   pages with no columns or rows. A full plan would populate these.
2. **Run of Show is a static table, not a database** — no per-segment status, no relations, no owner
   select. Times are `[00:00]` placeholders.
3. **Event Settings is minimal** — just 3 fields (Event, Budget, Event Date). No deadline, no location,
   no type, no owner relation as columns (those live as free-text in the page-level Overview instead).
4. **Status is single-state** — every Status property shows exactly one option ("Not started" / "Pull
   from storage"). The richer in-progress/done/blocked status spectrum a full plan would use is collapsed.
5. **Person/Owner columns are empty everywhere** — ownership is expressed via the **Role** select
   (Events/Comms/Production/Logistics Lead) and bracket placeholders, not assigned people.
6. **Offset is plain text (`T-14`)**, not a structured number/offset field — the Due Date formula that
   would consume it is left uncomputed in the export.
7. **Almost no rich sub-page content** — all task/supply/comms sub-pages have empty bodies; substance
   lives in the `Details`/`Notes` columns. Only one media asset exists (the flyer `IMG_2214.jpeg`).
8. **Reused Eden CSVs** — Comms internal name is still `Eden - Comms & Content Schedule`, confirming WWS
   is a trimmed copy of the Eden template.

The "extensible when authoring, trimmed when using" story: the template ships with the *full structure*
(6 databases, typed columns, relations, formulas, color-coded selects) but the *used instance* fills in
only the lightweight subset — 4 active databases, single-state statuses, role-not-person ownership, text
offsets, and stub Permits/Retrospective pages ready to expand when a heavier event needs them.

---

## Mapping to Our Column-Type Set — Gaps

Our set: `text, longtext, select, multiselect, status, number, currency, date, url, photo, person, role, offset_days, offset_minutes, due_date`.

- **Covered well:** text, longtext, select, multiselect, status, number, currency, date, person, photo
  (= files/image flyer), role (Tasks.Role maps cleanly), offset_days (Tasks "Offset (days)" T-N text),
  due_date (Tasks "Due Date (Dont Edit)" formula).
- **Gaps / unmodeled in our set:**
  - **relation** — Tasks.Event → Event Settings is a true cross-database relation. We have no relation type.
  - **rollup/lookup** — Tasks.Event Date mirrors the related event's date. No rollup type.
  - **formula** — Due Date and Comms.Date are formulas. If `due_date` is just a stored date, the
    *derivation* (Event Date + offset) isn't represented.
  - **offset_minutes** unused here (WWS offsets are day-grained only; minute offsets would matter for a
    Run-of-Show-as-database, which WWS doesn't have).
  - **url** unused as a dedicated property — links live inline inside longtext (Notion-doc references).
  - **"Days till event" / "Source" / "Packed in"** are extra selects/text our generic select covers, but
    note Comms uses a *plain select* for Status whereas Tasks/Supplies use a *status* type — our `status`
    vs `select` distinction must be chosen per-table.
