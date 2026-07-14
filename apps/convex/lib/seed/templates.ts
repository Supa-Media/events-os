/**
 * Seed template data + the chapter/roles/templates builder.
 *
 * Holds the large seed-data literals (per-module item rows) and
 * `buildChapterRolesAndTemplates`, the bulk builder shared by `seedDemoData`
 * and `ensureChapters`. Pure helper code (`ctx: any`); not a registered
 * function.
 */
import { Id } from "../../_generated/dataModel";
import { MutationCtx } from "../../_generated/server";
import {
  ACADEMY_TRAINING_TEMPLATES,
  DEFAULT_ROLES,
  LIGHTWEIGHT_ROLE_KEYS,
  GRID_CORE_MODULE_KEYS,
  type AcademyTrainingKind,
  type ModuleKey,
  type SelectOption,
} from "@events-os/shared";
import { toSlug, seedTemplateRoles } from "../templates";
import {
  addTemplateItems,
  seedTemplateCols,
  type ItemRow,
} from "./helpers";

/** Seed item rows for the new modules, shared between seedDemoData and backfillNewModules. */
export const PERMIT_ROWS: ItemRow[] = [
  { title: "Maria Hernandez Park Permit", offsetDays: -3, status: "approved", fields: { jurisdiction: "NYC Parks Dept", notes: "Park permit — holder must attend." } },
  { title: "Sound Permit", offsetDays: -3, status: "submitted", fields: { jurisdiction: "NYPD Precinct (amplified sound)", notes: "Amplified-sound permit via precinct officer ~3 days prior." } },
];

// Granular EXPECTATIONS — multiple per team, each tagged to a team value from
// VOLUNTEER_TEAM_OPTIONS. Distilled from eden.md §6 (per-team task lists) and the
// run-of-show setup notes. Columns are title / team / details (no status column).
export const VOLUNTEER_ROWS: ItemRow[] = [
  // 💐 Flower Team
  { title: "Set up flower tables, vases, and linens", fields: { team: "flower", details: "Dress the tables with linens, fill vases, and arrange flowers before guests arrive." } },
  { title: "Lay out blankets + stones seating area", fields: { team: "flower", details: "Set the garden-picnic vibe: blankets and stones for guests to settle on." } },
  // 🍅 Food/Bev Team
  { title: "Set up the grazing table", fields: { team: "food_bev", details: "Arrange charcuterie, plates, napkins, and utensils on the grazing table." } },
  { title: "Keep food + drinks stocked through the event", fields: { team: "food_bev", details: "Monitor levels, refill as needed, and keep the area clean." } },
  // 👋 Welcome Team
  { title: "Greet and direct guests on arrival", fields: { team: "welcome", details: "Welcome people in, point them to food/seating, and keep the entrance flowing." } },
  { title: "Hand out connect cards", fields: { team: "welcome", details: "Offer connect cards to new guests and answer questions." } },
  { title: "Run the merch + QR / donations table", fields: { team: "welcome", details: "Staff the small merch table, take Square payments, share the donations QR." } },
  // 🙏 Prayer Team
  { title: "Hold the prayer station", fields: { team: "prayer", details: "Set up the prayer sign + spot and be available throughout the event." } },
  { title: "Pray with anyone who comes forward", fields: { team: "prayer", details: "Listen and pray one-on-one with guests who want prayer." } },
  // 📷 Content Team
  { title: "Capture photos + video clips throughout the day", fields: { team: "content", details: "Grab candid moments, worship, and setup for recap content." } },
  { title: "Get key b-roll for the recap reel", fields: { team: "content", details: "Wide shots, crowd, and the gospel moment for the post-event clip." } },
];

export const RETRO_ROWS: ItemRow[] = [
  { title: "What went well?", status: "open" },
];

// ── Academy training templates (the capstones' sandboxes) ────────────────────
// Each capstone instantiates its own platform template. Quests are ordinary
// grid rows whose title starts with "Quest:" — academy.trainingStatus finds
// them by that prefix and counts one done when its status is terminal for its
// module. Each quest drills one move from the curriculum; the `details` /
// `notes` field tells the learner exactly how to do it in the app.

/** Title prefix that marks a training-event row as a quest. */
export const QUEST_TITLE_PREFIX = "Quest:";

/** A placeholder crew member a training template materializes onto its events. */
interface TrainingPersonSeed {
  name: string;
  team?: string;
  role?: string;
}

/** Everything needed to build one capstone's platform template + sandbox. */
export interface TrainingTemplateSpec {
  name: string;
  description: string;
  /**
   * Bump when the spec's CONTENT changes (rows, roles, people, columns,
   * modules). ensureTrainingTemplate refreshes an existing chapter's platform
   * template in place when its stored version is older — without this,
   * curriculum pages describing new quests would ship everywhere while
   * pre-existing chapters kept minting sandboxes from the frozen v1 template.
   */
  version: number;
  /** The sandbox event's name, from the learner's first name. */
  eventName: (firstName: string) => string;
  /**
   * How far out the sandbox event is dated. Horizons scale with the event —
   * the join-a-gathering sandbox sits a month out (big events plan on long
   * horizons); the party/pop-up sandboxes sit at ~2 weeks (the FLOOR for
   * planning anything, not the standard length of a plan).
   */
  eventDaysOut: number;
  disabledCoreModules: string[];
  /** Role keys from DEFAULT_ROLES this template carries. */
  roleKeys: string[];
  /** Per-module rows (quests + scenery). Modules not listed still get columns
   *  seeded if active, so their tabs render empty-but-usable. */
  rows: Partial<Record<ModuleKey, ItemRow[]>>;
  /** Select-option overrides per module+column (party crew teams). */
  columnOptionOverrides?: Partial<
    Record<ModuleKey, Record<string, SelectOption[]>>
  >;
  /** Sample crew placeholders, materialized as volunteer engagements. */
  people?: TrainingPersonSeed[];
  /**
   * Sample TEAMMATES the capstone's role quests assign — seeded onto the
   * chapter roster (once, reused across learners) by startTraining, not the
   * template: they're organizers to put in roles, not day-of crew.
   */
  sampleTeammates?: { name: string; role: string }[];
}

/** Party-appropriate crew teams for the birthday capstone's Crew Duties tab. */
const PARTY_TEAM_OPTIONS: SelectOption[] = [
  { value: "food", label: "Food", color: "amber" },
  { value: "games", label: "Games", color: "purple" },
  { value: "decor", label: "Decorations", color: "pink" },
  { value: "setup", label: "Setup", color: "blue" },
];

/**
 * CAPSTONE 1 — "Join an event": a large worship gathering mid-planning. The
 * learner takes the Comms Lead role; every tab is populated so the sandbox
 * feels like the real situation of being handed a role on someone else's
 * event. Quests live in Tasks (self-checked moves) and Comms (rows the
 * learner walks to Sent).
 */
const JOIN_EVENT_SPEC: TrainingTemplateSpec = {
  name: "Academy: Join a Gathering",
  version: 4,
  eventName: (firstName) => `Training: ${firstName} joins the gathering`,
  eventDaysOut: 30,
  description:
    "Capstone 1 sandbox — a large worship gathering already built from a template. The learner joins as Comms Lead. Instantiated per person by \"Start training\"; training events never appear in the Events tab or reminder emails.",
  disabledCoreModules: [],
  roleKeys: DEFAULT_ROLES.map((r) => r.key),
  rows: {
    planning_doc: [
      // Scenery — the event is mid-flight; earlier work is already done.
      { title: "Confirm date + rain plan", offsetDays: -30, role: "event_lead", status: "done" },
      { title: "Secure the park + start permit applications", offsetDays: -28, role: "event_lead", status: "done", fields: { details: "Park permit submitted at kickoff; the sound permit goes to the precinct ~3 days out." } },
      { title: "Confirm worship leaders + band", offsetDays: -21, role: "production_lead", status: "done" },
      { title: "Confirm production / AV plan", offsetDays: -7, role: "production_lead", status: "in_progress" },
      { title: "Pack gear + charge batteries", offsetDays: -1, role: "logistics_lead", status: "not_started" },
      // Quests.
      {
        title: "Quest: Take the Comms Lead role",
        offsetDays: -14,
        role: "comms_lead",
        fields: {
          details:
            "Roles before people. Tap Details in the event header, find Roles, and put yourself in Comms Lead. Then come back and tap this row's status to Done.",
        },
      },
      {
        title: "Quest: Find your work in Me view",
        offsetDays: -13,
        role: "comms_lead",
        fields: {
          details:
            "Switch to Me view — every tab filters down to rows that resolve to you. Count your comms rows so you know what you own. Then mark this Done.",
        },
      },
      {
        title: "Quest: Swap the Greeter placeholder for a person",
        offsetDays: -10,
        role: "comms_lead",
        fields: {
          details:
            "Placeholders are role-shaped slots ('Greeter'), and placeholders are debts — each becomes a named human before your template's crew lock point. Open the Crew tab and replace the Greeter placeholder with Maya or Jordan. (Sandbox pickers only ever offer you and sample people — you can't rope in real teammates from in here.) Then mark this Done.",
        },
      },
      {
        title: "Quest: Ask the assistant to brief you on your area",
        offsetDays: -9,
        role: "comms_lead",
        fields: {
          details:
            'Open the assistant and ask: "Brief me on my area — what\'s due, what\'s at risk, what\'s unowned?" It reads your live rows. Then mark this Done.',
        },
      },
      {
        title: "Quest: Mark the Comms Schedule ready",
        offsetDays: -2,
        role: "comms_lead",
        fields: {
          details:
            'Once your three comms quests read Sent, hit "Mark ready" on the Comms Schedule tab header — that\'s you signing your name to the stream. Then mark this Done.',
        },
      },
    ],
    comms: [
      // Scenery.
      { title: "Flyer request to marketing", offsetDays: -16, role: "comms_lead", status: "sent", fields: { channel: ["team_slack"], audience: ["leaders"] } },
      { title: "Countdown post", offsetDays: -7, role: "comms_lead", status: "drafted", fields: { channel: ["ig_stories"], audience: ["general_public"] } },
      { title: "Recap post", offsetDays: 3, role: "comms_lead", status: "not_started", fields: { channel: ["ig_post"], audience: ["general_public"] } },
      // Quests — real comms rows the learner walks to Sent.
      {
        title: "Quest: Send the announcement",
        offsetDays: -14,
        role: "comms_lead",
        status: "not_started",
        fields: {
          channel: ["ig_post", "ig_stories"],
          audience: ["general_public"],
          notes:
            "The venue is locked (check Tasks — that's the gate), so this can go out. Walk the status to Sent. In this sandbox nothing actually posts; statuses are claims you keep true.",
        },
      },
      {
        title: "Quest: Post the crew ask",
        offsetDays: -11,
        role: "comms_lead",
        status: "not_started",
        fields: {
          channel: ["ig_stories"],
          audience: ["general_public"],
          notes:
            "Cross-stream gate: never recruit against unwritten duties. Check the Crew Duties tab first — a past comms lead already wrote them. Then walk this to Sent.",
        },
      },
      {
        title: "Quest: Send the day-before call-time reminder",
        offsetDays: -1,
        role: "comms_lead",
        status: "not_started",
        fields: {
          channel: ["imessage_group"],
          audience: ["volunteers"],
          notes:
            "Your copy quotes call times — go read them off the Run of Show tab. That dependency is exactly why templates lock the run of show days before the event. Walk this to Sent.",
        },
      },
    ],
    run_of_show: [
      { title: "Load-in / Setup", offsetMinutes: -120, role: "logistics_lead", fields: { duration: 45 } },
      { title: "Soundcheck", offsetMinutes: -75, role: "production_lead", fields: { duration: 45 } },
      { title: "Crew huddle + prayer", offsetMinutes: -30, role: "event_lead", fields: { duration: 30 } },
      { title: "Doors / guest arrival", offsetMinutes: 0, role: "event_lead", fields: { duration: 15 } },
      { title: "Worship set", offsetMinutes: 15, role: "production_lead", fields: { duration: 30 } },
      { title: "Message + response", offsetMinutes: 45, role: "event_lead", fields: { duration: 45 } },
      { title: "Closing / next steps", offsetMinutes: 90, role: "event_lead", fields: { duration: 20 } },
      { title: "Strike / leave-no-trace", offsetMinutes: 110, role: "logistics_lead", fields: { duration: 20 } },
    ],
    supplies: [
      // "Timing" is the HAVE-IT-BY deadline: storage pulls resolve by T-1;
      // order-online rows carry the shipping lead time. Packing is tracked on
      // the Packing checklist (fields.packedIn), never as a status.
      { title: "2 x Shure SM58 Mics", status: "have_it", offsetDays: -1, fields: { source: "storage", container: "green_luggage", qty: 2, notes: "With the audio kit at Sam's place." } },
      { title: "Mixer", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage", qty: 1 } },
      { title: "1 x ALTO 600W Speaker", status: "have_it", offsetDays: -1, fields: { source: "storage", container: "on_its_own", qty: 1, notes: "In storage — confirm before pack day." } },
      { title: "1 x 200W Battery", status: "pull_from_storage", offsetDays: -2, fields: { source: "storage", container: "green_luggage", qty: 1, notes: "Charge at home the night before — no charger in storage." } },
      { title: "100 x Connect cards", status: "need_to_order", offsetDays: -10, fields: { source: "order_online", qty: 100, notes: "Shipping takes ~a week — order well before the T-1 pack." } },
    ],
    permits: [
      { title: "Park permit — Maria Hernandez Park", offsetDays: -21, status: "approved", fields: { notes: "Approved. Holder must attend." } },
      { title: "Amplified sound permit", offsetDays: -3, status: "submitted", fields: { notes: "Via the precinct officer, ~3 days prior." } },
    ],
    volunteer_expectations: [
      { title: "Greet and direct guests on arrival", fields: { team: "welcome", details: "Welcome people in, point them to seating, keep the entrance flowing." } },
      { title: "Hand out connect cards", fields: { team: "welcome", details: "Offer connect cards to new guests and answer questions." } },
      { title: "Hold the prayer station", fields: { team: "prayer", details: "Set up the prayer spot and be available throughout." } },
      { title: "Capture photos + clips", fields: { team: "content", details: "Candid moments, worship, and setup for the recap." } },
    ],
  },
  // Crew placeholders are ROLE-SHAPED slots ("Greeter"), not fake humans —
  // the learner's swap quest replaces one with a person from the sample bench.
  people: [
    { name: "Greeter (placeholder)", team: "welcome", role: "Greeter" },
    { name: "Sound + setup (placeholder)", team: "production", role: "Sound + setup" },
  ],
  sampleTeammates: [
    { name: "Maya (sample teammate)", role: "Trained organizer — sample" },
    { name: "Jordan (sample teammate)", role: "Trained organizer — sample" },
  ],
};

/**
 * CAPSTONE 2 — "Plan a party from scratch": a nearly-empty birthday party.
 * The learner owns the event, roles in two sample teammates (created by
 * startTraining, not the template), hires a paid clown, and walks rows across
 * four tabs to their terminal states. Permits toggled off — it also teaches
 * that not every event needs every tab.
 */
const BIRTHDAY_PARTY_SPEC: TrainingTemplateSpec = {
  name: "Academy: Birthday Party",
  version: 4,
  eventName: (firstName) => `Training: ${firstName}'s birthday party`,
  eventDaysOut: 14,
  description:
    "Capstone 2 sandbox — a from-scratch birthday party with sample teammates and crew. Instantiated per person by \"Start training\"; training events never appear in the Events tab or reminder emails.",
  disabledCoreModules: ["permits"],
  roleKeys: LIGHTWEIGHT_ROLE_KEYS,
  rows: {
    planning_doc: [
      {
        title: "Quest: Rename the party + set the date",
        offsetDays: -14,
        role: "event_lead",
        fields: {
          details:
            "Tap Details in the event header. Name it after the birthday human, pick a date, and watch every due date re-derive from it. Then mark this Done.",
        },
      },
      {
        title: "Quest: Add three tasks of your own, with timing",
        offsetDays: -12,
        role: "event_lead",
        fields: {
          details:
            "Use + Add row: e.g. send invites (T-10), order the cake (T-3), build the playlist (T-1). Give each an offset — a task without timing is invisible. Then mark this Done.",
        },
      },
      {
        title: "Quest: Give Maya and Jordan each a role",
        offsetDays: -10,
        role: "event_lead",
        fields: {
          details:
            "Maya and Jordan are sample teammates who've been through this training. Details (event header) → Roles: put one in Comms Lead and one in Logistics Lead. Delegation is the job — if everything resolves to you, you're doing it wrong. Then mark this Done.",
        },
      },
      {
        title: "Quest: Hire Sunny the Clown as paid crew",
        offsetDays: -7,
        role: "event_lead",
        fields: {
          details:
            "Crew tab → add crew → paid, amount $150, call time 30 minutes before guests. Uncle Ray and Cousin Lena are already there as volunteers — copy how they're set up. Watch the budget pick up Sunny's fee. Then mark this Done.",
        },
      },
      {
        title: "Quest: Ask the assistant to poke holes in your plan",
        offsetDays: -2,
        role: "event_lead",
        fields: {
          details:
            'Ask the assistant: "Is this party actually ready? What am I missing?" It checks your live rows against the readiness criteria. Then mark this Done.',
        },
      },
    ],
    comms: [
      {
        title: "Quest: Send the invites",
        offsetDays: -10,
        role: "comms_lead",
        status: "not_started",
        fields: {
          channel: ["imessage_group"],
          audience: ["attendees"],
          notes:
            "Draft the invite copy in this row's notes, then walk the status to Sent. Nothing actually sends in the sandbox — statuses are claims you keep true.",
        },
      },
    ],
    supplies: [
      {
        title: "Quest: Get the cake in hand",
        status: "need_to_order",
        offsetDays: -1,
        fields: {
          source: "order_online",
          qty: 1,
          notes:
            "Walk the status: Ordered → Have it. Then update Source + notes with where it lives ('fridge at Mom's') so whoever packs knows where to grab it. Packing itself is the Packing checklist, not a status — and nothing gets 'grabbed on the way'; that's how parties end up cakeless.",
        },
      },
    ],
    retro: [
      {
        title: "Quest: Log one learning and mark it Actioned",
        status: "open",
        fields: {
          notes:
            "Pretend the party happened. Write one concrete learning (\"the clown ran long; order more ice\"), pick a dispatch — promoted / context / dropped — then mark it Actioned.",
        },
      },
    ],
    volunteer_expectations: [
      { title: "Keep the grill going + food coming", fields: { team: "food", details: "Uncle Ray owns the grill. Keep the table stocked; flag when supplies run low." } },
      { title: "Decorate before guests arrive", fields: { team: "decor", details: "Cousin Lena: balloons, streamers, table setup — finished 30 minutes before guests." } },
      { title: "Run a 20-minute show after cake", fields: { team: "games", details: "Sunny the Clown's set. Someone owns the intro and the wrap-up." } },
    ],
  },
  columnOptionOverrides: {
    volunteer_expectations: { team: PARTY_TEAM_OPTIONS },
  },
  people: [
    { name: "Uncle Ray (sample crew)", team: "food", role: "Grill master" },
    { name: "Cousin Lena (sample crew)", team: "decor", role: "Decorations" },
  ],
  sampleTeammates: [
    { name: "Maya (sample teammate)", role: "Trained organizer — sample" },
    { name: "Jordan (sample teammate)", role: "Trained organizer — sample" },
  ],
};

/**
 * BONUS CAPSTONE — "Plan a worship event from scratch": the real thing, in
 * the domain the chapter actually runs. Optional; doesn't count toward the
 * trained badge.
 */
const WORSHIP_EVENT_SPEC: TrainingTemplateSpec = {
  name: "Academy: Worship Event",
  version: 4,
  eventName: (firstName) => `Training: ${firstName}'s worship event`,
  eventDaysOut: 14,
  description:
    "Bonus capstone sandbox — a from-scratch pop-up worship event. Instantiated per person by \"Start training\"; training events never appear in the Events tab or reminder emails.",
  disabledCoreModules: ["volunteer_expectations"],
  roleKeys: LIGHTWEIGHT_ROLE_KEYS,
  rows: {
    planning_doc: [
      {
        title: "Quest: Set your date + location",
        offsetDays: -14,
        role: "event_lead",
        fields: {
          details:
            "Details (event header): pick a date and put a real public spot in the location. The skeleton comes first — a date and a place. Then mark this Done.",
        },
      },
      {
        title: "Quest: Scout the spot + write the rain plan",
        offsetDays: -12,
        role: "event_lead",
        fields: {
          details:
            "Write your backup spot and what happens if it rains in this row's notes. Contingencies are structure, not vibes — written before you need them. Then mark this Done.",
        },
      },
      {
        title: "Quest: Confirm a worship leader",
        offsetDays: -11,
        role: "comms_lead",
        fields: {
          details:
            "In real life this is a call to the music team. Here: put the (pretend) name and number in this row's notes — details rich enough for a stranger. Then mark this Done.",
        },
      },
      {
        title: "Quest: Build the run of show",
        offsetDays: -3,
        role: "event_lead",
        fields: {
          details:
            "On the Run of Show tab, add segments with minute offsets: Load-in (−60), Sound check (−30), Huddle + prayer (−10), Worship set (0), Gospel + next steps (40), Strike (55). One named owner each. Then mark this Done.",
        },
      },
      {
        title: "Quest: Ask the assistant for a readiness briefing",
        offsetDays: -1,
        role: "event_lead",
        fields: {
          details:
            'Ask: "Is this event actually ready? Check it against the readiness criteria." Then mark this Done.',
        },
      },
    ],
    permits: [
      {
        title: "Quest: Sort the sound permit",
        offsetDays: -3,
        status: "to_apply",
        fields: {
          notes:
            "Amplified sound in public space needs a permit — via the local precinct, ~3 days out, and the permit holder must attend. Walk this row To apply → Submitted → Approved (in the sandbox, you're pretending the precinct said yes).",
        },
      },
    ],
    supplies: [
      {
        title: "Quest: Get the battery out, charged",
        status: "pull_from_storage",
        offsetDays: -2,
        fields: {
          source: "storage",
          container: "green_luggage",
          qty: 1,
          notes:
            "The battery leaves storage early enough to charge at home — there's no charger in storage. Walk it to Have it once it's charged and with you; day-before, check it off on the Packing checklist.",
        },
      },
    ],
    comms: [
      {
        title: "Quest: Announce it",
        offsetDays: -7,
        role: "comms_lead",
        status: "not_started",
        fields: {
          channel: ["ig_post", "ig_stories"],
          audience: ["general_public"],
          notes:
            "Gate check: is your location locked (quest 1 done)? Never announce an unconfirmed venue. Then walk this to Sent.",
        },
      },
    ],
    retro: [
      {
        title: "Quest: Capture one learning and dispatch it",
        status: "open",
        fields: {
          notes:
            "Pretend the event ran. Write one concrete, counted learning and dispatch it — promoted / context / dropped — then mark it Actioned. The debrief is finished when the template is better.",
        },
      },
    ],
  },
};

/**
 * ROLE CAPSTONE — "Run the comms" (Comms Lead course). A worship gathering
 * three weeks out where the comms AREA starts from zero: Crew expectations is
 * deliberately EMPTY (the learner writes the duties before recruiting), the
 * crew list has open placeholder slots, and the announcement hasn't moved.
 * The recruiting bench is four sample teammates — reaching out and filling a
 * slot IS the simulated yes.
 */
const COMMS_LEAD_SPEC: TrainingTemplateSpec = {
  name: "Academy: Run the Comms",
  version: 1,
  eventName: (firstName) => `Training: ${firstName} runs the comms`,
  eventDaysOut: 21,
  description:
    "Comms Lead capstone sandbox — duties first, then recruit: the learner writes each team's expectations, fills open crew slots from a sample bench, and runs the message schedule. Instantiated per person by \"Start training\"; training events never appear in the Events tab or reminder emails.",
  disabledCoreModules: [],
  roleKeys: DEFAULT_ROLES.map((r) => r.key),
  rows: {
    planning_doc: [
      // Scenery — the rest of the event is on track; only comms is at zero.
      { title: "Lock the venue + rain plan", offsetDays: -21, role: "event_lead", status: "done", fields: { details: "Locked — which is what gates your announcement." } },
      { title: "Confirm worship leader + band", offsetDays: -18, role: "production_lead", status: "done" },
      { title: "Pack gear + charge batteries", offsetDays: -1, role: "logistics_lead", status: "not_started" },
      // Quests.
      {
        title: "Quest: Take the Comms Lead role",
        offsetDays: -20,
        role: "comms_lead",
        fields: {
          details:
            "Roles before people. Details (event header) → Roles → put yourself in Comms Lead. Every unowned comms and crew row now resolves to you. Then mark this Done.",
        },
      },
      {
        title: "Quest: Write the Welcome team's duties",
        offsetDays: -18,
        role: "comms_lead",
        fields: {
          details:
            "The Crew tab's expectations are EMPTY — that's the job. Add at least two expectation rows tagged Welcome (greet + direct arrivals; hand out connect cards), each with details of what done looks like. This is the job description someone says yes to. Then mark this Done.",
        },
      },
      {
        title: "Quest: Write duties for Prayer and Content",
        offsetDays: -17,
        role: "comms_lead",
        fields: {
          details:
            "Same move, two more teams: one expectation row for Prayer (hold the prayer station), one for Content (capture photos + clips for the recap). Never recruit against unwritten duties. Then mark this Done.",
        },
      },
      {
        title: "Quest: Fill every open crew slot from your bench",
        offsetDays: -12,
        role: "comms_lead",
        fields: {
          details:
            "The crew list has three placeholder slots — Welcome table, Prayer lead, Content capture. Your bench is the sample people on your roster: Maya, Jordan, Sam, and Priya. In real life this is the text you send a friend; here, replace each placeholder with a person (sandbox pickers only ever offer you and sample people). Then mark this Done.",
        },
      },
      {
        title: "Quest: Chase every invite to Confirmed, with call times",
        offsetDays: -10,
        role: "comms_lead",
        fields: {
          details:
            "Invited is a maybe. On the Crew tab, walk each filled slot to Confirmed and give everyone a call time — confirmed people with call times are what run events. Then mark this Done.",
        },
      },
      {
        title: "Quest: Mark the Comms Schedule ready",
        offsetDays: -2,
        role: "comms_lead",
        fields: {
          details:
            "Once your three comms rows read Sent and your crew is confirmed, hit \"Mark ready\" on the Comms Schedule tab — that's you signing your name to the area, honestly. Then mark this Done.",
        },
      },
    ],
    comms: [
      // Scenery.
      { title: "Flyer request to marketing", offsetDays: -19, role: "comms_lead", status: "sent", fields: { channel: ["team_slack"], audience: ["leaders"] } },
      { title: "Recap post", offsetDays: 3, role: "comms_lead", status: "not_started", fields: { channel: ["ig_post"], audience: ["general_public"] } },
      // Quests — rows the learner walks to Sent.
      {
        title: "Quest: Post the crew ask",
        offsetDays: -15,
        role: "comms_lead",
        status: "not_started",
        fields: {
          channel: ["ig_stories"],
          audience: ["general_public"],
          notes:
            "Gate check: are the team duties written (your two duty quests)? Recruiting against unwritten expectations gets you warm bodies with no idea what to do. Once they're written, walk this to Sent.",
        },
      },
      {
        title: "Quest: Send the announcement",
        offsetDays: -14,
        role: "comms_lead",
        status: "not_started",
        fields: {
          channel: ["ig_post", "ig_stories"],
          audience: ["general_public"],
          notes:
            "The venue row on Tasks reads Done — locked venue, so this can go out. Draft the copy in these notes, then walk the status to Sent. Nothing actually posts in a sandbox; statuses are claims you keep true.",
        },
      },
      {
        title: "Quest: Send the T-1 call-time reminder",
        offsetDays: -1,
        role: "comms_lead",
        status: "not_started",
        fields: {
          channel: ["imessage_group"],
          audience: ["volunteers"],
          notes:
            "Your copy quotes call times — read them off the Run of Show tab (that dependency is why templates lock it days out). Walk this to Sent.",
        },
      },
    ],
    run_of_show: [
      { title: "Load-in / Setup", offsetMinutes: -120, role: "logistics_lead" },
      { title: "Soundcheck", offsetMinutes: -75, role: "production_lead" },
      { title: "Crew huddle + prayer", offsetMinutes: -30, role: "event_lead" },
      { title: "Doors / guest arrival", offsetMinutes: 0, role: "event_lead" },
      { title: "Worship set", offsetMinutes: 15, role: "production_lead" },
      { title: "Strike / leave-no-trace", offsetMinutes: 110, role: "logistics_lead" },
    ],
    supplies: [
      { title: "PA + mics", status: "have_it", offsetDays: -1, fields: { source: "storage", container: "green_luggage", notes: "With the audio kit." } },
      { title: "Connect cards", status: "ordered", offsetDays: -7, fields: { source: "order_online", qty: 100 } },
    ],
    permits: [
      { title: "Park permit", offsetDays: -14, status: "approved", fields: { notes: "Approved. Holder must attend." } },
      { title: "Amplified sound permit", offsetDays: -3, status: "submitted", fields: { notes: "Via the precinct officer, ~3 days prior." } },
    ],
    // volunteer_expectations intentionally seeds NO rows — writing the duties
    // is the capstone. The tab still gets its columns, empty-but-usable.
  },
  // Open, role-shaped slots the learner fills from the sample bench.
  people: [
    { name: "Welcome table (placeholder)", team: "welcome", role: "Welcome table" },
    { name: "Prayer lead (placeholder)", team: "prayer", role: "Prayer lead" },
    { name: "Content capture (placeholder)", team: "content", role: "Content capture" },
  ],
  // A four-person bench so "reach out and invite people in" has real choices.
  sampleTeammates: [
    { name: "Maya (sample teammate)", role: "Trained organizer — sample" },
    { name: "Jordan (sample teammate)", role: "Trained organizer — sample" },
    { name: "Sam (sample teammate)", role: "Trained organizer — sample" },
    { name: "Priya (sample teammate)", role: "Trained organizer — sample" },
  ],
};

/**
 * ROLE CAPSTONE — "Run the plan" (Event Lead course). A worship gathering
 * three weeks out that's drifting: an overdue task in the red band, a gap in
 * the plan, a stub run of show, and a permit nobody's applied for. The
 * learner triages it the way a real Event Lead inherits a mid-flight mess.
 */
const EVENT_LEAD_SPEC: TrainingTemplateSpec = {
  name: "Academy: Run the Plan",
  version: 1,
  eventName: (firstName) => `Training: ${firstName} runs the plan`,
  eventDaysOut: 21,
  description:
    "Event Lead capstone sandbox — a drifting plan to rescue: overdue rows, a missing task, an unbuilt run of show, and a permit on someone else's clock. Instantiated per person by \"Start training\"; training events never appear in the Events tab or reminder emails.",
  disabledCoreModules: [],
  roleKeys: DEFAULT_ROLES.map((r) => r.key),
  rows: {
    planning_doc: [
      // Scenery — the early work happened, then the plan started drifting.
      { title: "Secure the park", offsetDays: -30, role: "event_lead", status: "done" },
      { title: "Confirm worship leader + band", offsetDays: -24, role: "production_lead", status: "done" },
      // Quests.
      {
        title: "Quest: Take the Event Lead role",
        offsetDays: -20,
        role: "event_lead",
        fields: {
          details:
            "Details (event header) → Roles → put yourself in Event Lead. The accountability chain now ends at you: every unowned row on this event is yours until you place it. Then mark this Done.",
        },
      },
      {
        // Seeded ALREADY OVERDUE (due before the sandbox was created) so the
        // learner meets the red band and the amber pace check on day one.
        title: "Quest: Clear the overdue venue walkthrough",
        offsetDays: -25,
        role: "event_lead",
        status: "not_started",
        fields: {
          details:
            "This row is overdue — it's flagged red, it's in What's-next, and it's why the Planning ring reads amber. Overdue first, every time. Do the (pretend) walkthrough, note one thing you'd check in real life, and walk this to Done.",
        },
      },
      {
        title: "Quest: Add the missing task, written for a stranger",
        offsetDays: -14,
        role: "event_lead",
        fields: {
          details:
            "Nobody planned the food & water run. + Add row: give it a title, an offset (~T-2), an owner, and details rich enough that a stranger could run it cold — the how and the why, not just the what. Then mark this Done.",
        },
      },
      {
        title: "Quest: Give Maya and Jordan each an area",
        offsetDays: -13,
        role: "event_lead",
        fields: {
          details:
            "Delegation is the job. Details → Roles: put Maya and Jordan (sample teammates) into Comms Lead and Logistics Lead. Whole areas, not errands — if everything resolves to you, you're failing at the core skill. Then mark this Done.",
        },
      },
      {
        title: "Quest: Write the rain plan + permit fallback",
        offsetDays: -12,
        role: "event_lead",
        fields: {
          details:
            "Two contingencies, written while you're calm: what happens if it rains, and what happens if the sound permit is denied. Put both in this row's notes. Contingencies are structure, not vibes. Then mark this Done.",
        },
      },
      {
        title: "Quest: Build the run of show, one named owner per segment",
        offsetDays: -3,
        role: "event_lead",
        fields: {
          details:
            "The Run of Show tab has only Load-in. Add the day: Soundcheck (−75), Huddle + prayer (−30), Doors (0), Worship set (15), Message + response (45), Strike (110) — one named owner each. \"All\" is only acceptable for arrival, setup, and strike. Then mark this Done.",
        },
      },
      {
        title: "Quest: Ask the assistant for the owner's test",
        offsetDays: -2,
        role: "event_lead",
        fields: {
          details:
            'Ask the assistant: "If I disappeared today, what breaks? What\'s unowned, undated, or only in my head?" Fix what it finds — that\'s the plan passing the owner\'s test. Then mark this Done.',
        },
      },
    ],
    comms: [
      { title: "Announcement", offsetDays: -14, role: "comms_lead", status: "sent", fields: { channel: ["ig_post"], audience: ["general_public"] } },
      { title: "T-1 call-time reminder", offsetDays: -1, role: "comms_lead", status: "not_started", fields: { channel: ["imessage_group"], audience: ["volunteers"] } },
    ],
    run_of_show: [
      // A stub on purpose — building the rest IS a quest.
      { title: "Load-in / Setup", offsetMinutes: -120, role: "logistics_lead" },
    ],
    supplies: [
      { title: "PA + mics", status: "have_it", offsetDays: -1, fields: { source: "storage", container: "green_luggage" } },
      { title: "200W battery", status: "pull_from_storage", offsetDays: -2, fields: { source: "storage", notes: "Charge at home — no charger in storage." } },
    ],
    permits: [
      // Scenery.
      { title: "Park permit", offsetDays: -14, status: "approved", fields: { notes: "Approved. Holder must attend." } },
      // Quest — a real permit walked across someone else's clock.
      {
        title: "Quest: Walk the sound permit to Approved",
        offsetDays: -3,
        status: "to_apply",
        fields: {
          notes:
            "Amplified sound in public space needs a permit — via the precinct, ~3 days out, holder must attend. Walk it To apply → Submitted → Approved (the sandbox precinct says yes). In real life this starts at kickoff, because approval is never in your hands.",
        },
      },
    ],
    volunteer_expectations: [
      { title: "Greet and direct guests on arrival", fields: { team: "welcome", details: "Welcome people in, point them to seating, keep the entrance flowing." } },
      { title: "Capture photos + clips", fields: { team: "content", details: "Candid moments, worship, and setup for the recap." } },
    ],
    retro: [
      {
        title: "Quest: Log one learning and dispatch it",
        status: "open",
        fields: {
          notes:
            "Pretend the event ran. Write one concrete, counted learning, pick a dispatch — promoted / context / dropped — then mark it Actioned. The debrief is finished when the template is better, and the Event Lead owns that loop.",
        },
      },
    ],
  },
  sampleTeammates: [
    { name: "Maya (sample teammate)", role: "Trained organizer — sample" },
    { name: "Jordan (sample teammate)", role: "Trained organizer — sample" },
  ],
};

/**
 * ROLE CAPSTONE — "Run the supplies" (Logistics Lead course). A worship
 * gathering two weeks out whose supply list has every classic acquisition
 * problem on two clocks: an order whose shipping window is closing, a battery
 * in storage with no charger, ice nobody's bought, and gaps in the list.
 */
const LOGISTICS_LEAD_SPEC: TrainingTemplateSpec = {
  name: "Academy: Run the Supplies",
  version: 1,
  eventName: (firstName) => `Training: ${firstName} runs the supplies`,
  eventDaysOut: 14,
  description:
    "Logistics Lead capstone sandbox — get it, know where it lives, pack it: real acquisition walks across order/storage/buy, plus the packing checklist and the site map. Instantiated per person by \"Start training\"; training events never appear in the Events tab or reminder emails.",
  disabledCoreModules: ["permits", "volunteer_expectations"],
  roleKeys: LIGHTWEIGHT_ROLE_KEYS,
  rows: {
    planning_doc: [
      // Scenery.
      { title: "Lock the venue + rain plan", offsetDays: -14, role: "event_lead", status: "done" },
      // Quests.
      {
        title: "Quest: Take the Logistics Lead role",
        offsetDays: -13,
        role: "logistics_lead",
        fields: {
          details:
            "Details (event header) → Roles → put yourself in Logistics Lead. Every supply row with no owner is now yours to bring — blank isn't neutral. Then mark this Done.",
        },
      },
      {
        title: "Quest: Add two missing items with have-it-by timing",
        offsetDays: -10,
        role: "logistics_lead",
        fields: {
          details:
            "The list is yours to COMPLETE, not just execute: nobody added water or trash bags (the debrief classic). + Add row on Supplies for both, each with a source and a have-it-by offset — orders early, store runs later. Then mark this Done.",
        },
      },
      {
        title: "Quest: Draw the site map",
        offsetDays: -2,
        role: "logistics_lead",
        fields: {
          details:
            "On the Supplies & Logistics tab, open the site map and place the day: stage, welcome table, prayer station, arrival flow. The map is the spatial view of everything your grid tracks. Then mark this Done.",
        },
      },
      {
        title: "Quest: Run the packing checklist",
        offsetDays: -1,
        role: "logistics_lead",
        fields: {
          details:
            "Everything in hand by T-1, checked into its container on the Packing checklist — packed is a checklist, never a status. Check every Have-it item into a container. Then mark this Done.",
        },
      },
      {
        title: "Quest: Mark Supplies & Logistics ready",
        offsetDays: -1,
        role: "logistics_lead",
        fields: {
          details:
            "Everything in hand, packed, and placed on the map? Hit \"Mark ready\" on the Supplies & Logistics tab — your name on the claim, honestly. Then mark this Done.",
        },
      },
    ],
    comms: [
      { title: "Announcement", offsetDays: -10, role: "comms_lead", status: "sent", fields: { channel: ["ig_post"], audience: ["general_public"] } },
    ],
    run_of_show: [
      { title: "Load-in / Setup", offsetMinutes: -120, role: "logistics_lead" },
      { title: "Worship set", offsetMinutes: 15, role: "event_lead" },
      { title: "Strike / leave-no-trace", offsetMinutes: 110, role: "logistics_lead" },
    ],
    supplies: [
      // Scenery — some of the list is already handled.
      { title: "PA + mics", status: "have_it", offsetDays: -1, fields: { source: "storage", container: "green_luggage", notes: "With the audio kit at Sam's place." } },
      { title: "Folding tables ×2", status: "have_it", offsetDays: -1, fields: { source: "storage", container: "car", qty: 2 } },
      // Quests — real acquisition walks, one per clock.
      {
        title: "Quest: Order the connect cards before shipping closes",
        status: "need_to_order",
        offsetDays: -8,
        fields: {
          source: "order_online",
          qty: 100,
          notes:
            "Shipping takes ~a week, so the order goes out NOW — that's what the have-it-by Timing column is for. Walk it Need to order → Ordered → Have it, and keep the Link current so the next event re-orders without the archaeology.",
        },
      },
      {
        title: "Quest: Get the battery out, charged",
        status: "pull_from_storage",
        offsetDays: -2,
        fields: {
          source: "storage",
          container: "green_luggage",
          qty: 1,
          notes:
            "The VERY IMPORTANT row: the battery leaves storage early enough to charge at home, because there's no charger in storage. Walk it to Have it once it's charged and with you.",
        },
      },
      {
        title: "Quest: Buy the ice + record where it lives",
        status: "need_to_buy",
        offsetDays: -1,
        fields: {
          source: "buy_in_store",
          qty: 4,
          notes:
            "Store run near the end — ice doesn't keep. Walk it to Have it, then update Source/notes with where it lives (\"cooler in my trunk\") so pack day is a checklist run, not a scavenger hunt.",
        },
      },
    ],
  },
};

const TRAINING_TEMPLATE_SPECS: Record<AcademyTrainingKind, TrainingTemplateSpec> = {
  join_event: JOIN_EVENT_SPEC,
  birthday_party: BIRTHDAY_PARTY_SPEC,
  worship_event: WORSHIP_EVENT_SPEC,
  comms_lead: COMMS_LEAD_SPEC,
  event_lead: EVENT_LEAD_SPEC,
  logistics_lead: LOGISTICS_LEAD_SPEC,
};

/** The spec for one capstone kind (startTraining reads eventName/teammates). */
export function trainingTemplateSpec(kind: AcademyTrainingKind): TrainingTemplateSpec {
  return TRAINING_TEMPLATE_SPECS[kind];
}

/**
 * Ensure the chapter has the platform template for one capstone kind.
 * Idempotent by `isPlatform && platformKey`: returns the existing template's
 * id when one exists, otherwise builds it from its spec — roles, columns
 * (with any option overrides), quest + scenery rows, and sample crew
 * placeholders. A user template squatting the slug never satisfies the
 * lookup; the real one is seeded under a suffixed slug and matched on
 * `platformKey` from then on. Legacy platform templates (the pre-2026-07
 * single sandbox, which has no platformKey) are ignored. Called from
 * `buildChapterRolesAndTemplates` (new chapters) and from
 * `academy.startTraining` (self-heals chapters seeded before the Academy).
 */
export async function ensureTrainingTemplate(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  createdBy: Id<"users">,
  now: number,
  kind: AcademyTrainingKind,
): Promise<Id<"eventTypes">> {
  const key = ACADEMY_TRAINING_TEMPLATES[kind].templateKey;
  const spec = TRAINING_TEMPLATE_SPECS[kind];
  // Chapters hold a handful of templates — a full read here stays tiny, and
  // it's what lets the lookup key on platformKey even when a slug squatter
  // forced the platform template onto a suffixed slug.
  const chapterTypes = await ctx.db
    .query("eventTypes")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const existing = chapterTypes.find(
    (t) => t.isPlatform === true && t.platformKey === key,
  );
  if (existing) {
    // Refresh a stale template IN PLACE when the spec's content version
    // moved on. Existing sandboxes already cloned their content, so wiping
    // the template's rows/roles/columns/people never touches them; new
    // sandboxes (and reseedMissingRows self-heals) read the fresh content.
    if ((existing.version ?? 1) !== spec.version) {
      await wipeTemplateContent(ctx, existing._id);
      await ctx.db.patch(existing._id, {
        name: spec.name,
        description: spec.description,
        disabledCoreModules: spec.disabledCoreModules,
        version: spec.version,
        updatedAt: now,
      });
      await seedSpecContent(ctx, existing._id, spec, now);
    }
    return existing._id;
  }

  // A user template may be squatting on the exact slug — suffix past it.
  const taken = new Set(chapterTypes.map((t) => t.slug));
  let slug = key;
  for (let n = 2; taken.has(slug); n++) {
    slug = `${key}-${n}`;
  }

  const trainingId = await ctx.db.insert("eventTypes", {
    chapterId,
    name: spec.name,
    slug,
    isPlatform: true,
    platformKey: key,
    description: spec.description,
    disabledCoreModules: spec.disabledCoreModules,
    version: spec.version,
    isArchived: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
  await seedSpecContent(ctx, trainingId, spec, now);
  return trainingId;
}

/** Delete a platform template's content rows (items, columns, roles, people)
 *  ahead of a spec-version refresh. The template doc itself stays. */
async function wipeTemplateContent(
  ctx: MutationCtx,
  eventTypeId: Id<"eventTypes">,
): Promise<void> {
  const [items, cols, roles, people] = await Promise.all([
    ctx.db
      .query("templateItems")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", eventTypeId))
      .collect(),
    ctx.db
      .query("templateColumns")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", eventTypeId))
      .collect(),
    ctx.db
      .query("templateRoles")
      .withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId))
      .collect(),
    ctx.db
      .query("templatePeople")
      .withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId))
      .collect(),
  ]);
  for (const doc of [...items, ...cols, ...roles, ...people]) {
    await ctx.db.delete(doc._id);
  }
}

/** Seed a training template's content from its spec: roles, columns (with
 *  overrides), rows, and sample crew placeholders. */
async function seedSpecContent(
  ctx: MutationCtx,
  trainingId: Id<"eventTypes">,
  spec: TrainingTemplateSpec,
  now: number,
): Promise<void> {
  const roleSeeds = DEFAULT_ROLES.filter((r) => spec.roleKeys.includes(r.key));
  const roleByKey = await seedTemplateRoles(ctx, trainingId, roleSeeds);

  // Columns for every ACTIVE module (rows or not) so each tab renders ready
  // to use; rows only where the spec authored them.
  const disabled = new Set(spec.disabledCoreModules);
  for (const m of GRID_CORE_MODULE_KEYS) {
    if (disabled.has(m)) continue;
    await seedTemplateCols(
      ctx,
      trainingId,
      m,
      [],
      spec.columnOptionOverrides?.[m] ?? {},
    );
    const rows = spec.rows[m];
    if (rows && rows.length > 0) {
      await addTemplateItems(ctx, trainingId, m, rows, roleByKey);
    }
  }

  // Sample crew placeholders — materialized into volunteer engagements on
  // each sandbox by instantiateEvent's placeholder-crew pass.
  for (let i = 0; i < (spec.people?.length ?? 0); i++) {
    const p = spec.people![i];
    await ctx.db.insert("templatePeople", {
      eventTypeId: trainingId,
      name: p.name,
      teams: p.team ? [p.team] : undefined,
      role: p.role,
      order: i,
      createdAt: now,
    });
  }
}

/** Ensure all capstone training templates exist for a chapter. */
export async function ensureTrainingTemplates(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  createdBy: Id<"users">,
  now: number,
): Promise<void> {
  for (const kind of Object.keys(
    ACADEMY_TRAINING_TEMPLATES,
  ) as AcademyTrainingKind[]) {
    await ensureTrainingTemplate(ctx, chapterId, createdBy, now, kind);
  }
}

/**
 * Bootstrap a chapter's roles + default templates (the "group types"): the 4
 * editable default roles and the three event types — Eden (full), Love Thy
 * Neighbor (derived from Eden), and Worship With Strangers (lightweight). Shared
 * by `seedDemoData` and `ensureChapters` so both produce identical content.
 *
 * Creates NO people, membership, or sample events. Returns the created ids the
 * caller needs to attach a sample event/roster.
 */
export async function buildChapterRolesAndTemplates(
  ctx: any,
  chapterId: Id<"chapters">,
  createdBy: Id<"users">,
  now: number,
): Promise<{
  edenId: Id<"eventTypes">;
  ltnId: Id<"eventTypes">;
  wwsId: Id<"eventTypes">;
}> {
  // ── Eden template (full) ───────────────────────────────────────────────────
  const edenId = (await ctx.db.insert("eventTypes", {
    chapterId,
    name: "Eden",
    slug: toSlug("Eden"),
    description:
      "Full-scale flagship gathering: worship, message, ministry, and community activity.",
    // Eden runs every core module — nothing disabled.
    disabledCoreModules: [],
    version: 1,
    isArchived: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  })) as Id<"eventTypes">;

  // Eden owns the 4 default roles. Item rows resolve their role KEY to these ids.
  const edenRoleByKey = await seedTemplateRoles(ctx, edenId, DEFAULT_ROLES);

  for (const m of GRID_CORE_MODULE_KEYS) {
    await seedTemplateCols(ctx, edenId, m);
  }

  await addTemplateItems(ctx, edenId, "planning_doc", [
    { title: "Draft the plan + budget", offsetDays: -21, role: "event_lead", fields: { details: "Review the Tasks tab, set the budget, line up the meeting cadence." } },
    { title: "Confirm venue + file permits", offsetDays: -21, role: "event_lead", fields: { details: "Lock the park, file the sound permit, identify a weather backup." } },
    { title: "Reach out to music team for worship leaders + band", offsetDays: -14, role: "comms_lead", fields: { details: "Confirm 1–2 worship leaders + instrumentalists; send the song bank." } },
    { title: "Open volunteer sign-ups + brief", offsetDays: -14, role: "comms_lead" },
    { title: "Flyer + social push", offsetDays: -7, role: "comms_lead" },
    { title: "Confirm production / AV plan", offsetDays: -7, role: "production_lead", fields: { details: "Sound setup + power plan; contract videographer/photographer." } },
    { title: "Confirm supplies + packing checklist", offsetDays: -3, role: "logistics_lead" },
    { title: "Charge batteries + pack gear (night before)", offsetDays: -1, role: "logistics_lead" },
    { title: "Day-of setup + soundcheck", offsetDays: 0, role: "production_lead" },
    { title: "Retro + capture learnings", offsetDays: 2, role: "event_lead" },
  ], edenRoleByKey);

  // Supply "Timing" is the HAVE-IT-BY deadline: storage pulls by T-1 (pack
  // day), the battery by T-2 (charges at home overnight), in-store buys a
  // couple of days out, online orders early enough to survive shipping.
  await addTemplateItems(ctx, edenId, "supplies", [
    { title: "2 x Shure SM58 Mics", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage", qty: 2, notes: "With WWS audio kit" } },
    { title: "Mixer", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage", qty: 1 } },
    { title: "4 x XLR Cabling", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage", qty: 4 } },
    { title: "1 x ALTO 600W Speaker", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "on_its_own", qty: 1 } },
    { title: "1 x Charged 200W Battery", status: "pull_from_storage", offsetDays: -2, fields: { source: "storage", container: "green_luggage", qty: 1, notes: "Needs charging the night before — no charger in storage." } },
    { title: "100 x Red Napkins", status: "need_to_buy", offsetDays: -2, fields: { source: "buy_in_store", container: "cooler", qty: 100 } },
    { title: "Charcuterie supplies", status: "need_to_order", offsetDays: -7, fields: { source: "order_online", container: "cooler", notes: "Order online — shipping is a lead time like any other." } },
  ], edenRoleByKey);

  await addTemplateItems(ctx, edenId, "comms", [
    { title: "Reach out to marketing for flyer", offsetDays: -14, role: "comms_lead", fields: { channel: ["team_slack"], audience: ["leaders"], notes: "Hey [marketing], we're hosting Eden on [date] — can you create a flyer?" } },
    { title: "Ensure intro thread created", offsetDays: -13, role: "comms_lead", fields: { channel: ["team_slack"], audience: ["leaders"] } },
    { title: "Announce event on socials", offsetDays: -7, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
    { title: "Send a reminder to be on time", offsetDays: -3, role: "comms_lead", fields: { channel: ["imessage_group", "team_slack"], audience: ["leaders", "musicians"] } },
    { title: "Location + how to find us (day-of)", offsetDays: 0, role: "comms_lead", fields: { channel: ["ig_stories", "imessage_group"], audience: ["attendees", "general_public"] } },
    { title: "Post recap content", offsetDays: 3, role: "comms_lead", fields: { channel: ["ig_post"], audience: ["general_public"], notes: "Marketing decides exact timing — record what landed." } },
  ], edenRoleByKey);

  await addTemplateItems(ctx, edenId, "run_of_show", [
    { title: "Load-in / Setup", offsetMinutes: -120, role: "logistics_lead", fields: { duration: 45 } },
    { title: "Soundcheck", offsetMinutes: -75, role: "production_lead", fields: { duration: 45 } },
    { title: "Volunteer huddle + prayer", offsetMinutes: -30, role: "event_lead", fields: { duration: 30 } },
    { title: "Doors / soft start", offsetMinutes: 0, role: "event_lead", fields: { duration: 15 } },
    { title: "Worship set", offsetMinutes: 15, role: "production_lead", fields: { duration: 30 } },
    { title: "Message / Scripture", offsetMinutes: 45, role: "event_lead", fields: { duration: 25 } },
    { title: "Prayer / Ministry", offsetMinutes: 70, role: "event_lead", fields: { duration: 20 } },
    { title: "Community activity", offsetMinutes: 90, role: "comms_lead", fields: { duration: 25 } },
    { title: "Closing / Gospel + next steps", offsetMinutes: 115, role: "event_lead", fields: { duration: 15, notes: "Give the Gospel: we're all sinners; Jesus came and died for us so all who believe in Him are saved. Invite to connect + follow socials." } },
    { title: "Strike / Load-out", offsetMinutes: 130, role: "logistics_lead", fields: { duration: 15 } },
  ], edenRoleByKey);

  await addTemplateItems(ctx, edenId, "permits", PERMIT_ROWS, edenRoleByKey);
  await addTemplateItems(ctx, edenId, "volunteer_expectations", VOLUNTEER_ROWS, edenRoleByKey);
  await addTemplateItems(ctx, edenId, "retro", RETRO_ROWS, edenRoleByKey);

  // ── Love Thy Neighbor (derived from Eden — same structure) ─────────────────
  const ltnId = (await ctx.db.insert("eventTypes", {
    chapterId,
    name: "Love Thy Neighbor",
    slug: toSlug("Love Thy Neighbor"),
    description:
      "Annual neighbor-facing outreach — same structure as Eden, derived from it.",
    deriveFromEventTypeId: edenId,
    disabledCoreModules: [],
    version: 1,
    isArchived: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  })) as Id<"eventTypes">;
  // Clone Eden's roles, columns + items so LTN starts structurally aligned.
  // Item roleIds are remapped from Eden's role ids to LTN's own copies.
  const edenRoles = await ctx.db
    .query("templateRoles")
    .withIndex("by_template", (q: any) => q.eq("eventTypeId", edenId))
    .collect();
  const ltnRoleIdMap = new Map<string, Id<"templateRoles">>();
  for (const r of edenRoles) {
    const { _id, _creationTime, eventTypeId: _e, ...rest } = r as any;
    const newId = (await ctx.db.insert("templateRoles", {
      eventTypeId: ltnId,
      ...rest,
    })) as Id<"templateRoles">;
    ltnRoleIdMap.set(String(_id), newId);
  }
  const edenCols = await ctx.db
    .query("templateColumns")
    .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", edenId))
    .collect();
  for (const c of edenCols) {
    const { _id, _creationTime, eventTypeId: _e, ...rest } = c as any;
    await ctx.db.insert("templateColumns", { eventTypeId: ltnId, ...rest });
  }
  const edenItems = await ctx.db
    .query("templateItems")
    .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", edenId))
    .collect();
  for (const it of edenItems) {
    const { _id, _creationTime, eventTypeId: _e, ...rest } = it as any;
    await ctx.db.insert("templateItems", {
      eventTypeId: ltnId,
      ...rest,
      roleId: rest.roleId ? ltnRoleIdMap.get(String(rest.roleId)) : undefined,
    });
  }

  // ── Worship With Strangers (lightweight; trimmed supplies columns) ─────────
  const wwsId = (await ctx.db.insert("eventTypes", {
    chapterId,
    name: "Worship With Strangers",
    slug: toSlug("Worship With Strangers"),
    description:
      "Lightweight pop-up worship — a ~10% scaled-down variant of Eden, run by a 2–3 person team. The most important, most repeatable event.",
    deriveFromEventTypeId: edenId,
    // WWS is lightweight: it skips volunteer_expectations and keeps the rest.
    disabledCoreModules: ["volunteer_expectations"],
    version: 1,
    isArchived: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  })) as Id<"eventTypes">;

  // WWS owns only the 3 lightweight roles.
  const wwsRoleSeeds = DEFAULT_ROLES.filter((r) =>
    LIGHTWEIGHT_ROLE_KEYS.includes(r.key),
  );
  const wwsRoleByKey = await seedTemplateRoles(ctx, wwsId, wwsRoleSeeds);

  await seedTemplateCols(ctx, wwsId, "planning_doc");
  // WWS trims supplies down to what the team actually tracks (per the convo).
  await seedTemplateCols(ctx, wwsId, "supplies", ["qty", "owner", "role"]);
  await seedTemplateCols(ctx, wwsId, "comms");
  await seedTemplateCols(ctx, wwsId, "run_of_show");
  await seedTemplateCols(ctx, wwsId, "permits");
  await seedTemplateCols(ctx, wwsId, "retro");

  await addTemplateItems(ctx, wwsId, "planning_doc", [
    { title: "Update event date + create thread", offsetDays: -14, role: "event_lead", fields: { details: "Update the event date; start the WWS thread tagging owners." } },
    { title: "Highlight in monthly team meeting", offsetDays: -13, role: "event_lead", fields: { details: "Where it's happening this month + who's leading." } },
    { title: "Scout + confirm location", offsetDays: -12, role: "event_lead", fields: { details: "Identify a public spot + a weather/permitting backup; visit in person if possible (optional)." } },
    { title: "Check permits + public-space rules", offsetDays: -12, role: "event_lead" },
    { title: "Reach out to music leader to confirm worship leaders + band", offsetDays: -11, role: "comms_lead", fields: { details: "1–2 worship leaders + instrumentalists (keyboard and/or guitar, cajon optional). Put names + numbers in notes. Send the song bank." } },
    { title: "Announce event on socials", offsetDays: -7, role: "comms_lead" },
    { title: "Get all items from storage", offsetDays: -1, role: "logistics_lead", fields: { details: "Items live in the black/green luggage — just open and confirm everything's there." } },
    { title: "Make sure battery is charged", offsetDays: -1, role: "logistics_lead", fields: { details: "After bringing the battery out of storage, someone takes it home to charge — there's no charger in storage." } },
    { title: "Assign someone to set up sound day-of", offsetDays: 0, role: "event_lead" },
    { title: "Bring water for worship leaders + band", offsetDays: 0, role: "logistics_lead", fields: { cost: 20 } },
    { title: "Order food for worship leaders + volunteers", offsetDays: 0, role: "comms_lead", fields: { details: "~$20/person.", cost: 80 } },
    { title: "Hire videographer for clips", offsetDays: -10, role: "comms_lead", fields: { details: "iPhone footage is fine; ~$150 if hiring.", cost: 150 } },
  ], wwsRoleByKey);

  await addTemplateItems(ctx, wwsId, "supplies", [
    { title: "2 x Shure SM58 Mics", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage", notes: "With WWS audio kit" } },
    { title: "Mixer", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage" } },
    { title: "4 x XLR Cabling", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage" } },
    { title: "1 x ALTO 600W Speaker", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "on_its_own" } },
    { title: "1 x Charged 200W Battery", status: "pull_from_storage", offsetDays: -2, fields: { source: "storage", container: "green_luggage", notes: "Charge the night before — no charger in storage." } },
    { title: "Battery Charger", status: "pull_from_storage", offsetDays: -2, fields: { source: "storage", container: "green_luggage" } },
    { title: "2 x QR Code Signs", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage" } },
    { title: "Small table", status: "pull_from_storage", offsetDays: -1, fields: { source: "storage", container: "green_luggage" } },
  ], wwsRoleByKey);

  await addTemplateItems(ctx, wwsId, "comms", [
    { title: "Reach out to marketing for flyer", offsetDays: -14, role: "comms_lead", fields: { channel: ["team_slack"], audience: ["leaders"] } },
    { title: "Ensure intro thread created for WWS", offsetDays: -13, role: "comms_lead", fields: { channel: ["team_slack"], audience: ["leaders"], notes: "New thread: \"WWS [date] @Owner1, @Owner2\"" } },
    { title: "Announce event on socials", offsetDays: -7, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
    { title: "Reminder to be on time for leaders + musicians", offsetDays: -3, role: "comms_lead", fields: { channel: ["imessage_group", "team_slack"], audience: ["leaders", "musicians"], notes: "Friendly reminder WWS is at [location] [time] — show up ready to help set up." } },
    { title: "Day-before reminder with call time", offsetDays: -1, role: "comms_lead", fields: { channel: ["imessage_group"], audience: ["musicians"] } },
    { title: "Location + how to find us (day-of)", offsetDays: 0, role: "comms_lead", fields: { channel: ["ig_stories", "imessage_group"], audience: ["attendees", "general_public"], notes: "Pin the exact meet spot, what to look for, start time." } },
    { title: "Post a clip from the day", offsetDays: 3, role: "comms_lead", fields: { channel: ["ig_post"], audience: ["general_public"] } },
  ], wwsRoleByKey);

  await addTemplateItems(ctx, wwsId, "run_of_show", [
    { title: "Load-in / Setup", offsetMinutes: -60, role: "logistics_lead", fields: { duration: 30, notes: "Connect keyboard + recorder, then mics. Busking setup." } },
    { title: "Soundcheck", offsetMinutes: -30, role: "event_lead", fields: { duration: 20, notes: "Track playback, mic check levels." } },
    { title: "Team huddle + prayer", offsetMinutes: -10, role: "event_lead", fields: { duration: 10, notes: "Encouragement, have fun, worship boldly." } },
    { title: "Worship set", offsetMinutes: 0, role: "event_lead", fields: { duration: 40, notes: "Spontaneous worship — no set list." } },
    { title: "Closing / Gospel + next steps", offsetMinutes: 40, role: "event_lead", fields: { duration: 15, notes: "Give the Gospel: we're all sinners; Jesus came and died for us so all who believe in Him are saved. Invite to connect + follow socials." } },
    { title: "Strike / Load-out", offsetMinutes: 55, role: "logistics_lead", fields: { duration: 15 } },
  ], wwsRoleByKey);

  await addTemplateItems(ctx, wwsId, "permits", [
    { title: "Public-space / sound permit", offsetDays: -3, status: "to_apply", fields: { jurisdiction: "City Parks / local precinct", notes: "Check the park's amplified-sound rules; apply if required." } },
  ], wwsRoleByKey);

  // ── Academy training templates (the capstones' sandboxes) ──────────────────
  await ensureTrainingTemplates(ctx, chapterId, createdBy, now);

  return { edenId, ltnId, wwsId };
}
