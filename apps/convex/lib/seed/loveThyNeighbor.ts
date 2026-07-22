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
