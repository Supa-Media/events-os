# Eden 2026 – Event Plan (Notion Reference)

Faithful digest of the Notion export "Eden 2026 - Event Plan" for seeding templates.
Source: `~/Downloads/Eden event plan/` (HTML + CSV export).

The workspace is a top-level page ("Eden 2026 - Event Plan") containing four
inline **databases** (Planning Doc, Comms & Content Schedule, Supplies & Packing
Checklist, Permits — which itself holds two databases) and four structured
**prose sub-pages** that are *not* databases (Run of Show, Volunteer
Expectations, Day-Of Roles & Responsibilities, Retrospective).

Column types below are taken from the per-item sub-page property markup
(`property-row property-row-<type>`), which is authoritative. Select/status
option colors are taken from the list-view `select-value-color-<color>` classes.

---

## 1. Planning Doc — "Event Planning Tasks"

Database. 27 rows. 6 columns.

| Column  | Type      | Options / Notes |
| ------- | --------- | --------------- |
| Task    | text (title) | Row title |
| Details | text (long) | Free text, often multi-line bullet lists |
| Due     | date      | e.g. "May 23, 2026" |
| Notes   | text (long) | Rich multi-line; contains **inline links to other pages/databases** and external URLs (Google Docs, notion.so project brief, vercel app) |
| Owner   | person    | Multi-person (comma-separated): Sarah Gonzalez, Layomi Kupoluyi, Oluwadamilola (Ami) Osunseemi, Seyi Olujide, Austin Erickson, Tajzai Powell, Segun Olujide, juliechi__ |
| Status  | status    | Done (green), In progress (yellow), Blocked (red), (blank/gray) |

**Cross-database relations:** the Notes column links by URL/page-reference to
the Permits DB, Run of Show, Volunteer Expectations, Supplies & Packing
Checklist, Comms & Content Schedule, and an external "Project Brief" Notion page.
These are textual `notion.so`/relative-`.html` links, not a typed Relation
property.

### Rows

| Task | Due | Owner | Status | Details / Notes (abbrev.) |
|---|---|---|---|---|
| Confirm Eden event date + rain plan | May 23, 2026 | Sarah Gonzalez | Done | Lock spring weekend; rain/indoor fallback. Notes: applied 06/06, didn't get permit, shooting 06/07; permit looking unnecessary (sunny forecast). |
| Secure park/venue + permits (Picnic & Worship) | May 28, 2026 | Sarah Gonzalez | Done | Rules for amplified sound, food setup, crowd. Notes → links Permits DB; sound permit via precinct officer ~3 days prior; permit holder must attend. |
| Draft event run-of-show | June 15, 2026 | Sarah Gonzalez, Layomi Kupoluyi, Oluwadamilola Osunseemi | Done | Welcome, setlist, message/scripture, prayer, connection. Notes → links Run of Show. |
| Build volunteer roles list | June 18, 2026 | Sarah Gonzalez, Oluwadamilola Osunseemi | Done | Details = Google Doc URL. Notes → links Volunteer Expectations. |
| Confirm worship leader + core band roster | May 22, 2026 | Oluwadamilola Osunseemi, juliechi__ | Done | Julie picking leaders; Janelie + Bithje confirmed; possibly Julie; duet at end. |
| Create initial setlist + scripture/theme direction | May 22, 2026 | Oluwadamilola Osunseemi, juliechi__ | Done | Songs supporting bold public worship + gospel invitation. Follow up w/ Julie. |
| Sound plan: PA/mics + power + sound tech | May 31, 2026 | Seyi Olujide, Austin Erickson | Done | Detailed gear bullet list (speakers, XLR, batteries, keyboard, mixer, mics, guitar, cajon, mic stand). Notes → links Supplies DB. |
| Site walkthrough + layout map | May 25, 2026 | Sarah Gonzalez, Oluwadamilola Osunseemi, Tajzai Powell | Done | Sketch + flow for arrival/crowd. Take still photos for countdown. |
| Budget plan for $1000 | July 7, 2026 | — | Done | Allocate line items; donations/in-kind. Notes → Project Brief link. |
| Order event supplies | May 25, 2026 | Sarah Gonzalez, Oluwadamilola Osunseemi, Layomi Kupoluyi | Done | Storage list; ordering from Amazon; lanyard pickup; Print Mor pickup details (order #20236, Michaela Lawson). Notes → Supplies DB. |
| Launch communications plan | July 22, 2026 | — | Done | Weekly cadence; invite + what to bring. Notes → Comms DB. |
| Create signage list + copy | July 25, 2026 | — | Done | Welcome/prayer/picnic/trash; QR for follow-up. |
| Design event branding + promo assets | July 18, 2026 | — | Done | Garden/picnic + bold public worship theme. |
| Recruit volunteers + assign owners to roles | May 26, 2026 | Oluwadamilola Osunseemi | In progress | Meeting for run of show + expectations; leads for setup/sound/prayer/hospitality/cleanup/photo. Teams: Prayer (Segun, Jude, Sayo, Magdala), Welcome, Flower, Content. |
| Create planning document | — | Sarah Gonzalez, Oluwadamilola Osunseemi, Layomi Kupoluyi | Done | Notes → Project Brief link. |
| Conduct project brief meeting | — | Sarah Gonzalez | Done | Create calendar invite. |
| Food | May 31, 2026 | Sarah Gonzalez, Layomi Kupoluyi | Done | Volunteer + audience food. Pizza (8 boxes ~$25 Papa John's; cheese/pepperoni/bbq chicken/veggie from Pizza Hut), charcuterie/cold cuts, ordered ~6pm ~$1000. Notes → Project Brief. |
| Confirm who's leading message | May 25, 2026 | Segun Olujide | Done | Who leads message + prayer. |
| Get items from storage | May 31, 2026 | Tajzai Powell | Done | Tables, canopy, QR, banners, prayer sign, linen, flowers, vases, connect cards, coolers, tape for apple. Notes → Supplies DB; Zayy leading. |
| Inform contact to organize getting items from storage | May 20, 2026 | Oluwadamilola Osunseemi | Done | |
| Recruit photographer/videographer | May 22, 2026 | Layomi Kupoluyi | Done | Sayo videography, Christine photography. |
| Stand for selling merch | — | — | (blank) | Need small table. Square payments app; 1 person; add to volunteer doc. |
| Get fake tree with apple on it | May 31, 2026 | Tajzai Powell, Seyi Olujide | Done | Fake olive tree from Seyi's; tie apple with rope. |
| Get food permit | May 29, 2026 | Sarah Gonzalez | Blocked | COI / proof of insurance — couldn't get these. |
| Buying Flowers | May 30, 2026 | Sarah Gonzalez, Layomi Kupoluyi | Done | Originally Costco/Instacart; ended up local florist (cheaper, free bulk flowers). |
| Scavengar hunt game | May 25, 2026 | juliechi__, Oluwadamilola Osunseemi, Layomi Kupoluyi | Done | Michaele + Julie build game/assets; built an app: https://scavenger-hunt-beryl.vercel.app/ |
| Get day of items | May 31, 2026 | Oluwadamilola Osunseemi | Done | Ice, napkins, plates (storage), flowers. |

---

## 2. Comms & Content Schedule

Database. 27 rows. 9 columns.

| Column | Type | Options / Notes |
| --- | --- | --- |
| Comm Title | text (title) | Row title |
| Audience | multi_select | General Public (brown), Attendees (gray), Worshippers (purple), Leaders (green), Volunteers (yellow), Production (red) |
| Channel/Medium | multi_select | IG Post (pink), IG Stories (yellow), TikTok (purple), Partiful (green), Team Slack (red), iMessage Volunteer Group (gray), Audience Preferred (blue) |
| Date | **formula** | Renders a date (e.g. "Tuesday, April 28, 2026"). In Notion this is a computed/date formula property, not raw date entry. |
| Days till event | text | Manually entered offset label like `T-33`, `T-7`, `T-1`, `T-0`, `T+3`. (This is the human-readable countdown; **maps to our offset_days concept**.) |
| Files & media | file | Attached images (relative paths to .jpeg files in export) |
| Notes | text (long) | Message intent / copy direction |
| Owner | person | Multi-person |
| Status | status | Done, Not started, Removed |

Note: sub-page bodies do **not** carry extra prose beyond these properties; the
rich media is the `Files & media` attachment (flyers/screenshots).

### Rows

| Comm Title | Audience | Channel | Date | T- | Files | Owner | Status |
|---|---|---|---|---|---|---|---|
| Main announcement post | General Public | IG Post, IG Stories | Apr 28, 2026 | T-33 | IMG_2214.jpeg | Sarah Gonzalez | Done |
| Worshipper lineup ask / confirmations | Worshippers | Audience Preferred | May 1, 2026 | T-30 | | juliechi__ | Done |
| Production/instruments team check-in | Leaders, Production | Team Slack | May 24, 2026 | T-7 | | Seyi Olujide, juliechi__ | Done |
| Call for volunteers | General Public | IG Stories | May 20, 2026 | T-11 | | Sarah Gonzalez, Ami Osunseemi | Done |
| 1-Day countdown | General Public | IG Stories, TikTok | May 30, 2026 | T-1 | | Charisma Stevens | Done |
| Volunteer pen-ultimate reminder | Leaders, Volunteers | Team Slack, iMessage Volunteer Group | May 30, 2026 | T-1 | | Ami Osunseemi | Done |
| Volunteer final reminder (day-of) | Leaders, Volunteers | iMessage Volunteer Group | May 31, 2026 | T-0 | | Ami Osunseemi | Done |
| Thank you to volunteers | Leaders, Volunteers | Team Slack, iMessage Volunteer Group | May 31, 2026 | T-0 | | Ami Osunseemi, Layomi Kupoluyi | Done |
| Location + how to find us (day-of) | Attendees, General Public | IG Stories, Partiful | May 31, 2026 | T-0 | | Sarah Gonzalez, Layomi Kupoluyi | Done |
| Thank you / recap for attendees | Attendees, General Public | Partiful | May 31, 2026 | T-0 | IMG_2219, IMG_2218.jpeg | Layomi Kupoluyi | Done |
| Feedback request (post) | Attendees, Volunteers | Partiful, iMessage Volunteer Group | Jun 3, 2026 | T+3 | | Layomi Kupoluyi, Charisma Stevens | Not started |
| Make volunteer request flyer and a form | — | — | — | — | | Ami Osunseemi | Not started |
| 4-day countdown | Attendees, General Public | IG Post, IG Stories, TikTok | May 27, 2026 | T-4 | | Layomi Kupoluyi | Removed |
| 7-day countdown | Attendees, General Public | IG Post, IG Stories, TikTok | May 24, 2026 | T-7 | | Layomi Kupoluyi, Charisma Stevens | Done |
| Partiful message to guests | Attendees, General Public | Partiful | May 28, 2026 | T-3 | IMG_2222.jpeg | Sarah Gonzalez | Removed |
| Partiful message to guests | Attendees, General Public | Partiful | May 24, 2026 | T-7 | IMG_2222.jpeg | Sarah Gonzalez | Done |
| Create group chat for volunteers + meeting msg | Volunteers | iMessage Volunteer Group | May 23, 2026 | T-8 | | Ami Osunseemi | Done |
| Schedule run of show meeting with leaders | Leaders | Team Slack | May 19, 2026 | T-12 | | Sarah Gonzalez | Done |
| Schedule run of show meeting with worshippers | — | iMessage Volunteer Group | May 25, 2026 | T-6 | | juliechi__ | Removed |
| Send volunteer role reminder | Volunteers | iMessage Volunteer Group | May 24, 2026 | T-7 | | Ami Osunseemi | Done |
| Send volunteer role reminder | Volunteers | iMessage Volunteer Group | May 28, 2026 | T-3 | | Ami Osunseemi | Done |
| Send volunteer role reminder | Volunteers | iMessage Volunteer Group | May 30, 2026 | T-1 | | Ami Osunseemi | Done |
| Send a run of show and slack reminder to leaders | Leaders | Team Slack | May 21, 2026 | T-10 | | Sarah Gonzalez | Done |
| Send a reminder to be on time for leaders | — | Team Slack | May 28, 2026 | T-3 | | Sarah Gonzalez | Removed |
| Send a reminder to be on time for leaders | — | Team Slack | May 30, 2026 | T-1 | | Layomi Kupoluyi | Done |
| D-day reminder for leaders | — | Team Slack | May 31, 2026 | T-0 | | Layomi Kupoluyi | Done |
| Scavenger hunt text blast | Attendees, General Public | Partiful | May 31, 2026 | T-0 | IMG_2224.jpeg | Layomi Kupoluyi | Done |
| Schedule volunteer meeting | Volunteers | iMessage Volunteer Group | May 24, 2026 | T-7 | | Ami Osunseemi | Done |

(Notes column per row carries the message copy/intent — see CSV for full text.)

---

## 3. Supplies & Packing Checklist

Database. 46 rows. 8 columns. **Each item is its own sub-page** (the export has
46 individual .html files), but the sub-page body adds no prose beyond the
properties — content lives entirely in the cells.

| Column | Type | Options / Notes |
| --- | --- | --- |
| Item | text (title) | Row title |
| Notes | text | e.g. "Audio / sound", "@Layomi Kupoluyi", "Audio / sound — need charging" |
| Owner | person | Mostly Seyi Olujide on audio gear |
| Packed in | select | On its Own (yellow), Green luggage (green), Black Luggage (purple) |
| Qty | text | Numeric values but stored as text ("1", "2") |
| Source | select | Storage (blue), Misc (gray), Seyi's home (green), Order online (orange) |
| Status | status | Pull from storage, Have it, Need to order, Packed, (blank) |
| Stored / Location | text | Free text: "Storage", "Seyi's place", "LK Has it", "Austins House", "Segun & Temi's House", etc. |

### Rows (Item | Notes | Owner | Packed in | Qty | Source | Status | Location)

| Item | Notes | Owner | Packed in | Qty | Source | Status | Location |
|---|---|---|---|---|---|---|---|
| Table for grazing | | | | | Storage | Pull from storage | Storage |
| QR code for payments | | | | | Storage | Pull from storage | Storage |
| Table for flowers | | | | | Storage | Pull from storage | Storage |
| Small table for merch | | | | | Storage | Pull from storage | Storage |
| Canopy | | | | 1 | Storage | Pull from storage | Storage |
| Standing banners | | | | | Storage | Pull from storage | Storage |
| Prayer standing sign | | | | | Storage | Pull from storage | Storage |
| Linen for the tables | | | | | Storage | Pull from storage | Storage |
| Vases | | | | | Storage | Pull from storage | Storage |
| Fake flowers | | | | | Storage | Pull from storage | Storage |
| Public Worship connect cards | | | Black Luggage | | Seyi's home | Have it | Storage |
| Coolers | | | | | Storage | Pull from storage | Storage |
| Tape for apple | | | | | Order online | Need to order | Storage |
| 200 x Small Plates | | | Black Luggage | | Order online | Packed | |
| Butcher paper | | | Black Luggage | | Order online | Packed | |
| Linen | | | | | Order online | Need to order | |
| 80 x Mini Forks | | | Black Luggage | | Order online | Packed | |
| 100 x Red Napkins | | | Black Luggage | | Order online | Packed | |
| Ribbon | | | Black Luggage | | Order online | Packed | |
| Scissors | | | Black Luggage | | Order online | Packed | |
| Tissue paper | | | | | Order online | Need to order | |
| Lanyards | @Layomi Kupoluyi | | | | Order online | Have it | LK Has it |
| Napkin holder | | | | | Order online | Need to order | |
| Table umbrella | | | | | Order online | Need to order | |
| Bucket | | | | | Order online | (blank) | |
| Keyboard | Audio / sound | Seyi Olujide | On its Own | | Seyi's home | Have it | Seyi's place |
| Line array speakers | Audio / sound | Seyi Olujide | On its Own | 2 | Seyi's home | Have it | Seyi's place |
| Big portable batteries | Audio / sound — need charging | Seyi Olujide | Green luggage | 2 | Seyi's home | Have it | Seyi's place |
| Small portable battery (for keyboard) | Audio / sound | Seyi Olujide | Green luggage | | Seyi's home | Have it | Seyi's place |
| XLR cabling (speakers to mixer) | Audio / sound | Seyi Olujide | | | Storage | Pull from storage | Storage |
| Mixer | Audio / sound | Seyi Olujide | Green luggage | | Seyi's home | Have it | Seyi's place (with WWS equipment) |
| 2 x Mics & XLR cables | Audio / sound | Seyi Olujide | Green luggage | 2 | Seyi's home | Have it | Seyi's place (with WWS equipment) |
| Guitar & cabling | Audio / sound | Seyi Olujide | | | Storage | Pull from storage | Storage |
| Extra mic & XLR cabling (for Cajon) | Audio / sound | Seyi Olujide | | | Storage | Pull from storage | Storage |
| Mic stand | Audio / sound | Seyi Olujide | | | Storage | Pull from storage | Storage |
| 2 x 1/4 inch to XLR Cable | @Austin Erickson | | | | Misc | (blank) | Austins House |
| 46 x Merch Pieces | | | On its Own | | Seyi's home | Have it | |
| 80 x Mini Spoons | | | Black Luggage | | Order online | Packed | |
| Disposable Gloves | | | Black Luggage | | Order online | Packed | |
| Keyboard Stand | | | | | Storage | Pull from storage | |
| Drum Seat | | | | | Storage | Pull from storage | U |
| 2 x IECs for speakers | | | Green luggage | | Seyi's home | Have it | |
| Small Table | | | Green luggage | | Seyi's home | Have it | |
| 4 x Welcome Sings 2xQr Codes | | | Green luggage | | Seyi's home | Have it | |
| Keyboard Pedal & Cord | | | | | Seyi's home | Packed | In Seyis bag for rehearsal |
| Cajon (Drum) | | | | | Storage | Pull from storage | |
| 5-10 Foldable Chairs | | | | | Misc | (blank) | Segun & Temi's House |

---

## 4. Permits (page containing two databases)

The "Eden - Permits" page hosts two databases plus an attached PDF
(`EDEN_Maria_Hernandez_Permit.pdf`).

### 4a. Event - Permits

Database. 2 rows. 4 columns. (Looks like a Notion "form/responses" database.)

| Column | Type | Options / Notes |
| --- | --- | --- |
| Question 1 | text (title) | Row title |
| Files & media | file | PDF attachment |
| Respondent | created_by (person) | Sarah Gonzalez |
| Submission time | created_time (date) | timestamp |

| Question 1 | Files | Respondent | Submission time |
|---|---|---|---|
| Maria Hernandez Park Permit | EDEN_Maria_Hernandez_Permit.pdf | Sarah Gonzalez | May 17, 2026 7:45 PM |
| Sound Permit | (none) | Sarah Gonzalez | May 17, 2026 7:49 PM |

### 4b. Document Hub

Database. 3 rows. 6 columns. (Appears to be a stock Notion template, lightly used.)

| Column | Type | Options / Notes |
| --- | --- | --- |
| Doc name | text (title) | Row title |
| Category | multi_select | Strategy doc, Proposal, Customer research |
| Created by | created_by (person) | Sarah Gonzalez |
| Created time | created_time (date) | timestamp |
| Last edited by | last_edited_by (person) | Sarah Gonzalez |
| Last updated time | last_edited_time (date) | timestamp |

| Doc name | Category | Created/Edited |
|---|---|---|
| Company mission and strategy | Strategy doc | Sarah Gonzalez, May 17, 2026 7:47 PM |
| Proposal for new year campaign | Proposal | Sarah Gonzalez, May 17, 2026 7:47 PM |
| Customer feedback report | Customer research | Sarah Gonzalez, May 17, 2026 7:47 PM |

---

## 5. Run of Show (prose sub-page, not a database)

A structured page with an **Event Info** block and a **table** (Time | Segment |
Owner | Notes/Tech) that functions like a run-sheet. Modeled here as a table.

**Event Info**
- Event Name: Eden
- Date: Sunday, May 31st, 2026
- Location: Maria Hernandez Park | P33G+7F, Brooklyn, NY 11237
- **Call Times:** Team Arrival 11:30am–12:00pm · Team huddle 12:15pm · Setup 12:30pm · Start 2:00pm

**Run of Show table** (this is the key time/call-time content):

| Time | Segment | Owner | Notes / Tech |
|---|---|---|---|
| 11:30am – 12:00pm | Team Arrival | All | Team and volunteers arrive |
| 12:15pm | Team Huddle | Seyi Olujide | Team discussion, intentions, prayer |
| 12:30pm | Teams Break / Volunteer Brief | Ami Osunseemi | Dami gathers everyone; leads divide responsibilities (Welcome, Food/Bev, Worship, Content, Prayer) |
| 1:00pm | Set up | All | Blankets + stones; grazing table; prayer team spots + signs; worship sing posts; banners |
| 2:00pm | Guest Arrival | Welcome Team | Guests settle, food/drinks, blankets, background music; welcome team directs |
| 2:30pm | Welcome / Event Kick off | Layomi Kupoluyi | Prayer & short devotional; introduce Scavenger |
| 2:45pm | Scavenger hunt / bingo / eat | (—) | Emcee encourages merch buying; merch next to food |
| 3:30pm | Worship Set | Johnelle | Emcee introduces worship; Julie to confirm |
| 4:00pm | Worship Set | Bithja | |
| 4:30pm | Word | Segun Olujide | 10 minutes |
| 4:40pm | Worship Set – Duet | Johnelle and Bithja | |
| 5:10pm | Final Announcements / giving charge | Seyi Olujide | Prayer & ministry announcement; wrap at 6pm; welcome team passes donations QR |
| 6:00pm | Strike / Load-out | All | Leave no trace |

**Program assets:** Setlist [TBD]; Playback tracks [TBD]; Spoken points/script: Seyi.
**Contingencies:** Rain plan — reschedule, backup 6/7 Maria Hernandez Park (permit pending); Noise/sound — permit pending; Safety incident lead — Zayy P (347) 294-7095.

The Time column = explicit clock times (call-times / time-of-day), with one
range row (11:30am–12:00pm). Owner column here is free text (mixes @person
mentions and plain names like "Johnelle", "Bithja", "All", "Welcome Team").

---

## 6. Volunteer Expectations (prose sub-page)

Rich onboarding doc (not a database). Contains:
- **Volunteer Snapshot**: Event Name, Date, Location, Arrival time (12:00pm), Volunteer lead contact (@Ami Osunseemi).
- **Expectations (Core)**, **Dress Code / What to Bring** (White T-shirt + Public Worship Lanyard; water, sunscreen, comfy shoes).
- **Per-team task lists** with goals + "You'll set up" / "You'll do" bullets and team headcounts: 💐 Flower Team (2), 🍅 Food/Bev Team (2), 👋 Welcome Team (6), 🙏 Prayer Team, 📷 Content Team.
- **Embedded external links** (Dropbox signage PNGs, Instagram FAQ post) and **page links** to Run of Show.
- **Volunteer Call Time / Team Assignment** example row: "Sarah Example — 9498128267 — 1:00pm — Flower Team" (implies a per-volunteer name/phone/call-time/team table).
- Day-Of Flow, Safety & Escalation (911, Zayy 347-294-7095), Helpful Links, and an embedded **Site Map** image (`Eden_Site_Map.png`, plus `image.png`, `image 1.png`).

---

## 7. Day-Of Roles & Responsibilities (prose sub-page)

Not a database. Contains:
- **Team Leads (Fill)**: Event Lead (@Ami Osunseemi, @Layomi Kupoluyi), Worship Lead (@juliechi__), Production Lead (@Seyi Olujide), Comms Lead (@Layomi Kupoluyi), Volunteer Lead (@Ami Osunseemi), Safety Lead (@Tajzai Powell).
- **Day-Of Roles**: per-role responsibility bullets (Event Lead, Volunteer Lead, Welcome/Hospitality, Prayer Team Lead, Production (A/V), Comms/Content Capture, Activities Lead).
- **Pre-Event Responsibilities (Checklist)** — checkbox bullets.
- **Day-Of Checklist** — checkbox bullets (huddle, safety scan, start on time, cleanup/leave no trace).

These are Notion **to-do/checkbox** list items (unchecked in export).

---

## 8. Retrospective (prose sub-page)

Not a database. A numbered **Feedback** list of retro items (each with optional
sub-notes), e.g.: seats not needed; get a counter; tighter setup/pack-down
instructions; station leads; too much food (placement); buy 20 more blankets;
people not singing (place worshippers in back/middle); recurring/monthly giving;
circular vs pointed stage; stage management; better sound (contract speakers);
need COI contact; text-blast app for volunteers; announce volunteers alongside
event; trash bags; arrive earlier to secure space (Saturday priority).
Ends with a **Google Sheets link** to feedback survey results.

---

## Database inventory (counts)

| Database | Rows | Columns |
|---|---|---|
| Planning Doc (Event Planning Tasks) | 27 | 6 |
| Comms & Content Schedule | 27 | 9 |
| Supplies & Packing Checklist | 46 | 8 |
| Permits → Event - Permits | 2 | 4 |
| Permits → Document Hub | 3 | 6 |

Prose (non-DB) sub-pages: Run of Show, Volunteer Expectations, Day-Of Roles &
Responsibilities, Retrospective.

## Union of column types observed

`text` (title + long), `multi_select`, `select`, `status`, `date`, `formula`,
`file` (files/media: images + PDF), `person`, plus Notion system properties
`created_by`, `created_time`, `last_edited_by`, `last_edited_time`. Qty values
are numeric but stored as `text`. "Days till event" is a `text` countdown label
(`T-33`…`T+3`). Run-of-show "Time" column is clock time-of-day (with ranges).
Day-Of/Pre-event checklists are checkbox to-do items.
