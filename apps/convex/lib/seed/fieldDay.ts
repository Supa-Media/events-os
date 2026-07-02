/**
 * "Field Day" template seed rows, ported from the Notion "Field Day 2026" plan.
 *
 * One reusable event template (a park cookout + games gathering). Timing is
 * RELATIVE to the event: day offsets for the day-modules (Comms, Planning,
 * Permits) and minute offsets from a 1:00 PM program start for Run of Show, so
 * the template reuses cleanly each year. Consumed by `seed.fieldDayTemplate`.
 */
import type { ItemRow } from "./helpers";

// Reference points used to turn the Notion's absolute dates/times into
// event-relative offsets (deterministic — Date.parse of fixed strings).
const EVENT_DAY = "2026-08-08";
const PROGRAM_START = "2026-08-08T13:00:00"; // 1:00 PM kickoff
const daysToEvent = (iso: string) =>
  Math.round((Date.parse(iso) - Date.parse(EVENT_DAY)) / 86_400_000);
const minsFromStart = (iso: string) =>
  Math.round((Date.parse(iso) - Date.parse(PROGRAM_START)) / 60_000);

// ── Comms & Content Schedule ────────────────────────────────────────────────
export const FIELD_DAY_COMMS: ItemRow[] = [
  { title: "Main announcement post", offsetDays: -30, fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
  { title: "Discuss comms schedule with social media team", offsetDays: daysToEvent("2026-07-02"), fields: { channel: ["team_slack"] } },
  { title: "Schedule run of show meeting with directors", offsetDays: daysToEvent("2026-07-02"), fields: { channel: ["team_slack"], audience: ["leaders"] } },
  { title: "Set up auto-send for Posh notifications", offsetDays: daysToEvent("2026-07-08"), fields: { channel: ["partiful_posh"] } },
  { title: "Call for volunteers on socials", offsetDays: -21, fields: { channel: ["ig_stories", "imessage_group", "team_slack"], audience: ["volunteers", "leaders"], notes: "Create a group chat for volunteers and message to schedule a volunteers meeting." } },
  { title: "Story post", offsetDays: daysToEvent("2026-07-12"), fields: { channel: ["ig_stories"] } },
  { title: "Story post", offsetDays: daysToEvent("2026-07-19"), fields: { channel: ["ig_stories"] } },
  { title: "Schedule volunteer meeting", offsetDays: daysToEvent("2026-07-21"), fields: { audience: ["volunteers"] } },
  { title: "Send volunteer role reminder", offsetDays: daysToEvent("2026-07-22"), fields: { channel: ["imessage_group"], audience: ["volunteers"] } },
  { title: "Save the date + how to get tickets (Post on IG)", offsetDays: daysToEvent("2026-07-24"), fields: { channel: ["ig_post", "partiful_posh"], audience: ["general_public", "attendees"] } },
  { title: "Logistics post for socials (time, location, bring list)", offsetDays: -7, fields: { channel: ["ig_post", "audience_preferred"], audience: ["attendees"] } },
  { title: "Story post", offsetDays: daysToEvent("2026-07-26"), fields: { channel: ["ig_stories"] } },
  { title: "Feed post", offsetDays: daysToEvent("2026-07-26"), fields: { channel: ["ig_post"] } },
  { title: "Story post", offsetDays: daysToEvent("2026-08-02"), fields: { channel: ["ig_stories"] } },
  { title: "Story post (3 days out)", offsetDays: -3, fields: { channel: ["ig_stories"] } },
  { title: "Partiful/Posh message to guests (3 days out)", offsetDays: -3, fields: { channel: ["partiful_posh"], audience: ["attendees"] } },
  { title: "Reminder to be on time — directors/core team", offsetDays: -2, fields: { channel: ["team_slack"], audience: ["leaders"] } },
  { title: "Reminder to be on time — volunteers", offsetDays: -2, fields: { channel: ["imessage_group"], audience: ["volunteers"] } },
  { title: "T-2 days story post", offsetDays: -2, fields: { channel: ["ig_stories"] } },
  { title: "T-1 reminder + arrival/check-in (story post)", offsetDays: -1, fields: { channel: ["ig_stories"] } },
  { title: "Core team penultimate reminder", offsetDays: -1, fields: { channel: ["team_slack"], audience: ["leaders"] } },
  { title: "Volunteer penultimate reminder (roles, good vibes)", offsetDays: -1, fields: { channel: ["imessage_group"], audience: ["volunteers"] } },
  { title: "Ginger the Field Day people on Posh/Partiful", offsetDays: -1, fields: { channel: ["partiful_posh"], audience: ["attendees"] } },
  { title: "Day-of: where to find us on Partiful/Posh + Stories", offsetDays: 0, fields: { channel: ["partiful_posh", "ig_stories"], audience: ["attendees"] } },
  { title: "Core team good morning chat", offsetDays: 0, fields: { channel: ["team_slack"], audience: ["leaders"] } },
  { title: "Volunteers good morning chat", offsetDays: 0, fields: { channel: ["imessage_group"], audience: ["volunteers"] } },
  { title: "Post-event recap + thanks + impact", offsetDays: 2, fields: { channel: ["ig_post", "audience_preferred"], audience: ["attendees", "general_public", "volunteers"] } },
  { title: "Ask attendees to fill out survey", offsetDays: 3, fields: { channel: ["audience_preferred"], audience: ["attendees"] } },
];

// ── Planning Document (status: done | in_progress | not_started) ─────────────
export const FIELD_DAY_PLANNING: ItemRow[] = [
  { title: "Create Project Brief (Field Day)", status: "done", offsetDays: daysToEvent("2026-05-02"), fields: { details: "Anchor doc for goals, schedule, budget estimates, and team members.", notes: "Owner: Mohena JeanPierre" } },
  { title: "Create project planning document", status: "in_progress", offsetDays: daysToEvent("2026-06-02"), fields: { details: "Flesh out this doc.", notes: "Owners: Mohena JeanPierre, Tajzai Powell, Layomi Kupoluyi" } },
  { title: "Finalize event date & location", status: "done", offsetDays: daysToEvent("2026-06-29"), fields: { details: "Confirm venue + any permits needed.", notes: "Prospect Park. Aug 8, 12:30–6:30pm. Volunteers by 10:45am. Rain date Aug 8. Waiting on June 5th permit decision to confirm." } },
  { title: "Secure location permit", status: "in_progress", offsetDays: daysToEvent("2026-07-21"), fields: { details: "Contact venue/city for requirements; confirm liability coverage for games + food.", notes: "FIFA World Cup makes June 11 – July 19 tough." } },
  { title: "Secure sound permit", status: "in_progress", offsetDays: daysToEvent("2026-07-23"), fields: { notes: "Apply after the location permit." } },
  { title: "Secure food permit", status: "in_progress", offsetDays: daysToEvent("2026-07-23"), fields: { notes: "Valid for a year." } },
  { title: "Draft overall budget + track purchases", status: "in_progress", offsetDays: daysToEvent("2026-07-05"), fields: { details: "Include food/drinks, games, prizes, rentals, ice, sandbags, etc.", notes: "Owner: Tajzai Powell. Mirror the project brief's budget sections." } },
  { title: "Create flyers for the event", status: "done", offsetDays: daysToEvent("2026-06-05"), fields: { details: "Reach out to Michaela for flyers." } },
  { title: "Create Partiful/Posh link for RSVPs", status: "in_progress", offsetDays: daysToEvent("2026-07-03"), fields: { details: "Partiful — familiar. Posh — no Venmo needed. Expecting 200 people; $25/person; goal $5,000.", notes: "Double-checking with Seyi & Charisma for the Public Worship Posh account." } },
  { title: "Set ticketing plan", status: "done", fields: { details: "Ticket price $25 (adults). Decide where to sell + deadlines. Track toward the $5,000 goal." } },
  { title: "Finalize schedule / run of show", status: "in_progress", offsetDays: daysToEvent("2026-07-02"), fields: { details: "Use the brief's schedule blocks (setup → wrap-up)." } },
  { title: "Set up meeting with leaders re: run of show", status: "not_started", offsetDays: daysToEvent("2026-06-07"), fields: { details: "Invite team members in the general Slack channel.", notes: "Timeline depends on permit." } },
  { title: "Build volunteer roles document", status: "in_progress", offsetDays: daysToEvent("2026-07-05"), fields: { details: "Food distribution (5–6), Prayer (4), Referees (5) — 10 teams/20 per team, Welcome (4), Grillers (2). Gameplay: 2 teams versing each other; accumulate points; bottom 2 eliminated.", notes: "Michael could be good for grill." } },
  { title: "Recruit photographer/videographer", status: "not_started", offsetDays: daysToEvent("2026-06-13"), fields: { notes: "Photography — Christine/Arena. Videography — Kirk (Production team)." } },
  { title: "Volunteer solicitation / engagement", status: "not_started", offsetDays: daysToEvent("2026-07-08"), fields: { details: "Reach out to volunteers, create a group chat, set up a meeting.", notes: "Zayy to reach out to grillers." } },
  { title: "Order event food", status: "not_started", offsetDays: daysToEvent("2026-06-27"), fields: { details: "Cookout (grilled): burgers, hotdogs, chicken, ribs. Variety chips, drinks, condiments, table covering, burners, trash bags.", notes: "Zayy & Mo — Costco order the morning of (opens 9:30am). Condiments ordered beforehand." } },
  { title: "Get car rental", status: "not_started", offsetDays: daysToEvent("2026-06-13"), fields: { details: "7-seater." } },
  { title: "Decide on Emcee", status: "not_started", offsetDays: daysToEvent("2026-06-08"), fields: { notes: "Reach out to Jeff with forewarning. LK is backup." } },
  { title: "Go through run of show with Emcee", status: "not_started", offsetDays: daysToEvent("2026-06-20"), fields: { details: "Confirm MC/host; include safety reminders + purpose + group photo." } },
  { title: "Confirm games list", status: "not_started", offsetDays: daysToEvent("2026-06-06"), fields: { details: "Volleyball; Tic Tac Toe $105 (5); Twister $21 (1); Basketball hoop $90 (1); Flag Football $60 (2); Kick Ball $35 (1); Relay $80 (2); Corn Hole $35 (1)." } },
  { title: "Create music playlist", status: "not_started", offsetDays: daysToEvent("2026-07-30") },
  { title: "Purchase/borrow games + supplies", status: "not_started", offsetDays: daysToEvent("2026-06-06"), fields: { notes: "Amazon list: https://www.amazon.com/hz/wishlist/ls/LAJU26CQ412Z?type=wishlist" } },
  { title: "Decor + signage", status: "not_started", fields: { details: "Prayer signage. Include name tags/wristbands + Love Thy Neighbor messaging." } },
  { title: "Other equipment", status: "not_started", fields: { details: "Tent x2, dollys to carry things from the car. Tell people to bring blankets." } },
  { title: "Create promo materials + posting schedule", status: "not_started", fields: { details: "Flyer + social captions; highlight purpose, ticket link, date/time/location." } },
  { title: "Set up registration/check-in workflow", status: "not_started", fields: { details: "Wristbands/name tags, attendee list, payment verification, staffing." } },
  { title: "Create safety plan + first aid coverage", status: "not_started", fields: { details: "Heat plan (water/shade), injury protocol, boundaries for games. Designate first-aid lead + supplies." } },
  { title: "Build day-before checklist", status: "not_started", fields: { details: "Print schedules/signage, charge speakers, pack supplies, etc." } },
  { title: "Create cleanup + teardown plan", status: "not_started", fields: { details: "Assign teardown crew; trash plan; venue walkthrough; equipment return." } },
  { title: "Post-event wrap", status: "not_started", fields: { details: "Send thank-yous; recap + lessons learned." } },
];

// ── Run of Show (minute offsets from the 1:00 PM start) ─────────────────────
export const FIELD_DAY_RUN_OF_SHOW: ItemRow[] = [
  { title: "Setup Crew Arrives", offsetMinutes: minsFromStart("2026-08-08T10:00:00"), fields: { notes: "Owner: Setup Lead. Tables, tents, chairs, decorations, game stations. Food + check-in area organized. Playlist tested & water stations filled." } },
  { title: "Arrival & Check-In", offsetMinutes: minsFromStart("2026-08-08T12:00:00"), fields: { notes: "Owner: Check-In Lead. Registration table open (name tags, wristbands). Icebreaker as people arrive. Light snacks & drinks." } },
  { title: "Opening Prayer & Kick-Off", offsetMinutes: minsFromStart("2026-08-08T12:30:00"), fields: { notes: "Owner: MC/Host. Welcome, prayer & short devotional, rundown + safety reminders, group photo." } },
  { title: "Afternoon Games", offsetMinutes: minsFromStart("2026-08-08T13:00:00"), fields: { notes: "Owner: Games Lead. R1 Sack Relay + Hoola Hoop (top 8 advance); R2 3-Legged + Over/Under (top 6); R3 Tug of War + Water Balloon Toss (top 4); R4 Obstacle + Balloon Ankle (top 2); R5 Family Feud / Kickball / Cup Stack." } },
  { title: "Refreshment Break", offsetMinutes: minsFromStart("2026-08-08T15:00:00"), fields: { notes: "Owner: Hospitality Lead. Food & drinks served. Fellowship under tents/shade." } },
  { title: "Big Group Game", offsetMinutes: minsFromStart("2026-08-08T16:00:00"), fields: { notes: "Owner: Activity Lead. Kickball OR Dodgeball (everyone can join or cheer)." } },
  { title: "Team Challenges", offsetMinutes: minsFromStart("2026-08-08T17:00:00"), fields: { notes: "Owner: Activity Lead. Scavenger hunt; trivia or Bible challenge (seated option). Randomize teams." } },
  { title: "Grand Finale Game", offsetMinutes: minsFromStart("2026-08-08T17:30:00"), fields: { notes: "Owner: Games Lead. Capture the Flag, 2 teams, randomize again." } },
  { title: "Closing & Wrap-Up", offsetMinutes: minsFromStart("2026-08-08T18:00:00"), fields: { notes: "Owner: MC/Host. Awards (Most Spirit, MVP…), closing prayer, group picture & thank-yous, begin clean-up." } },
  { title: "Strike / Clean-up", offsetMinutes: minsFromStart("2026-08-08T18:30:00"), fields: { notes: "Owner: Setup Lead. Leave no trace." } },
];

// ── Volunteer Expectations (one row per team) ───────────────────────────────
export const FIELD_DAY_VOLUNTEER: ItemRow[] = [
  { title: "Welcome Team", fields: { team: "welcome", details: "Be the first warm face guests see. Greet warmly, orient them (games, food, prayer, restrooms, info), help people find their team, keep the entry clear. Lead with warmth; attend to newcomers or anyone standing alone." } },
  { title: "Prayer Team", fields: { team: "prayer", details: "Offer gentle prayer coverage and care. Pray with anyone who asks; approach respectfully; keep it discreet. Escalate anything sensitive to the Volunteer Lead." } },
  { title: "Content Team", fields: { team: "content", details: "Capture raw, natural moments. Phone/camera + storage/battery; shoot setup, games, food, wide crowd + detail shots. Ask consent for close-ups (esp. kids); never film prayer without consent; share with the lead after." } },
  { title: "Referees", fields: { details: "Keep games fair, fun, and on time. Explain rules, start/stop games, track time/points, keep rotations moving; settle disputes calmly; prioritize safety; flag injuries/unsafe behavior to the Volunteer Lead immediately." } },
  { title: "Food Distribution", fields: { team: "food_bev", details: "Keep food + drink welcoming, stocked, and clean. Set up the station (liners, trash bags, utensils), serve efficiently, monitor portions, tidy continuously, restock early. Sanitize hands; when unsure about allergens, ask." } },
];

// ── Permits (from the planning doc; the Notion Permits page was empty) ───────
export const FIELD_DAY_PERMITS: ItemRow[] = [
  { title: "Location permit", status: "to_apply", offsetDays: daysToEvent("2026-07-21"), fields: { notes: "Contact venue/city; confirm liability coverage. FIFA World Cup makes June 11 – July 19 tough. Rain date Aug 8." } },
  { title: "Sound permit", status: "to_apply", offsetDays: daysToEvent("2026-07-23"), fields: { notes: "Apply after the location permit." } },
  { title: "Food permit", status: "to_apply", offsetDays: daysToEvent("2026-07-23"), fields: { notes: "Valid for a year." } },
];
