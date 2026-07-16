/**
 * The Academy — the ordered training curriculum.
 *
 * Thirty short sections across the three streams (Events, Works, Management):
 * concept pages, one page per native area tab, an assistant page, hands-on
 * capstones (per-role and ownership; one optional bonus), and the Works
 * (projects & duties) and Management (1:1s, care + accountability, directing)
 * modules. Content is authored FROM the playbook (docs/agent.md) and
 * the enablement guides (docs/guides/*) — this file is the single source both
 * the mobile Academy screens and the Convex grading backend read, so the quiz
 * is always graded server-side against exactly what the reader saw.
 *
 * Authoring rules (learned from the v1 rewrite):
 *  - Teach the SOFTWARE first, the doctrine second. Numbers like "announce at
 *    T-14" are the templates' proven defaults, not laws of the app — say so.
 *  - Short pages (2–4 min). One idea per block. The click path is part of the
 *    lesson, not a footnote.
 *  - Quizzes teach, not trick: every explanation restates the rule checked.
 */

/** One quiz question. `answerIndex` points into `options`. */
export interface AcademyQuestion {
  prompt: string;
  options: string[];
  answerIndex: number;
  /** Shown after grading — restates the rule, right or wrong. */
  explanation: string;
}

/** One option of a `try_status` demo chip (colors match the app's real select chips). */
export interface AcademyStatusOption {
  value: string;
  label: string;
  /** Option color token (gray / amber / green / …) — same vocabulary as real status columns. */
  color: string;
}

/** One bubble of an `agent_demo` scripted exchange. */
export interface AcademyExchange {
  who: "you" | "agent";
  text: string;
}

/**
 * One typed content block of an Academy article. Articles are authored as a
 * sequence of blocks (not a markdown blob) so the mobile renderer can give
 * each kind a designed treatment — story callouts, principle cards, tables,
 * and interactive practice widgets — instead of generic markdown output.
 * Prose (`text` / `items` / table cells) may carry `**bold**` and `*italic*`
 * inline emphasis.
 *
 * The `try_*` / `reveal` / `agent_demo` kinds are INTERACTIVE: self-contained
 * widgets with throwaway local state, styled pixel-close to the real app so
 * practicing in the article transfers one-to-one. They never write to the
 * backend.
 */
export type AcademyBlock =
  | { kind: "p"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  /** "From the field" pull-quote — a real anecdote (title like "Eden, 2026"). */
  | { kind: "story"; title: string; text: string }
  /** Key-principle card — the rule the section hangs on. */
  | { kind: "rule"; title: string; text: string }
  /** Tabular content (tab overviews, cadences, lead times…). */
  | { kind: "table"; headers: string[]; rows: string[][] }
  /** "In the app · …" pointer to the concrete UI move. */
  | { kind: "tip"; text: string }
  /** Mini grid row with a tappable status chip — cycle it to the terminal state. */
  | {
      kind: "try_status";
      title: string;
      options: AcademyStatusOption[];
      /** The terminal option's `value` — reaching it shows the success line. */
      terminal: string;
      caption?: string;
    }
  /** T-offset sandbox: pick an offset, move the event date, watch due dates re-derive. */
  | { kind: "try_offset"; eventDateLabel?: string }
  /** The accountability chain, rendered as links you can break. */
  | { kind: "try_chain" }
  /** Mark-ready simulator: criteria checklist, gated button, honest override path. */
  | { kind: "try_ready"; criteria: string[] }
  /** Scenario card: "what would you do?" with a tap-to-reveal playbook answer. */
  | { kind: "reveal"; prompt: string; answer: string }
  /** Scripted assistant exchange, revealed bubble-by-bubble on tap. */
  | { kind: "agent_demo"; exchanges: AcademyExchange[] };

/** The interactive block kinds (practice widgets with local state). */
export const ACADEMY_INTERACTIVE_KINDS = [
  "try_status",
  "try_offset",
  "try_chain",
  "try_ready",
  "reveal",
  "agent_demo",
] as const satisfies readonly AcademyBlock["kind"][];

/**
 * Which training sandbox a capstone section drives. Each kind maps to its own
 * platform training template (ACADEMY_TRAINING_TEMPLATES) and each learner
 * gets their own sandbox event per capstone.
 */
export type AcademyTrainingKind =
  | "join_event"
  | "birthday_party"
  | "worship_event"
  | "comms_lead"
  | "event_lead"
  | "logistics_lead";

/** Capstone metadata carried by a capstone section. */
export interface AcademyCapstoneMeta {
  kind: AcademyTrainingKind;
}

/** One curriculum section: an article (typed content blocks) + its quiz. */
export interface AcademySection {
  slug: string;
  /** 1-based position in the curriculum (sections unlock in this order). */
  order: number;
  title: string;
  subtitle: string;
  /** Rough read estimate, minutes. */
  minutes: number;
  /** The article, as an ordered sequence of typed blocks. */
  blocks: AcademyBlock[];
  /** Empty for capstones — their "quiz" is the training-event quest list. */
  quiz: AcademyQuestion[];
  /** Present on capstone sections: which training sandbox completes them. */
  capstone?: AcademyCapstoneMeta;
  /**
   * A bonus section: unlocks in order like any other, but does NOT count
   * toward "fully trained" (completed/total exclude it).
   */
  optional?: boolean;
}

/**
 * The per-kind platform training templates the capstones instantiate.
 * `templateKey` is the stable `eventTypes.platformKey` value (never suffixed,
 * unlike the slug, so a slug squatter can't hijack the lookup).
 */
export const ACADEMY_TRAINING_TEMPLATES: Record<
  AcademyTrainingKind,
  { templateKey: string }
> = {
  join_event: { templateKey: "academy-join-event" },
  birthday_party: { templateKey: "academy-birthday-party" },
  worship_event: { templateKey: "academy-worship-event" },
  comms_lead: { templateKey: "academy-comms-lead" },
  event_lead: { templateKey: "academy-event-lead" },
  logistics_lead: { templateKey: "academy-logistics-lead" },
};

/**
 * Whether an event counts toward chapter OPERATIONS. Academy training
 * sandboxes (`isTraining`) are real events, but they must never surface in
 * operational views: event lists, the Events tab, dashboards, Team workload
 * views, or reminder emails. Every exclusion site shares this one predicate.
 */
export function isOperationalEvent(e: {
  isTraining?: boolean | null;
}): boolean {
  return e.isTraining !== true;
}

// The curriculum, in reading order. `order` is DERIVED from array position
// (see the ACADEMY_SECTIONS export below) so a mid-curriculum insert can
// never silently break the sequential-unlock chain with duplicate or gapped
// order numbers.
const SECTIONS_IN_ORDER: Omit<AcademySection, "order">[] = [
  // ── 1 · What Chapter OS is ──────────────────────────────────────────────────
  {
    slug: "what-is-events-os",
    title: "What Chapter OS is",
    subtitle: "One place for the whole plan",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Chapter OS is where an event's plan lives: every task, message, supply, permit, and person — in one place, instead of a group chat, three spreadsheets, and somebody's memory.",
      },
      {
        kind: "rule",
        title: "The plan lives in the app, not in a head",
        text: "Anyone on the team should be able to open the event and see exactly what's left, whose it is, and when it's due. Every feature you'll learn exists to make that sentence true.",
      },
      { kind: "heading", text: "Templates and events" },
      {
        kind: "bullets",
        items: [
          'A **template** is the reusable blueprint for a *kind* of event — "Worship With Strangers", "Eden", or one you make. It holds the roles, the tabs, and the standard to-dos with their timing.',
          "An **event** is one dated copy of a template. Creating an event copies the whole structure and turns every \"10 days before\" into a real due date. From then on the event is yours to edit freely.",
        ],
      },
      {
        kind: "p",
        text: "Templates hold what's **always** true; events hold what's true **this time**. When you learn something that will matter at every future event, fix the *template* — that's how the next team starts smarter than you did.",
      },
      {
        kind: "story",
        title: "Eden, 2026",
        text: 'At Eden — the flagship gathering this app grew out of — the debrief said *"we needed trash bags."* The fix was not a note in a doc somewhere. It was a **new supplies row in the template**, so no future event can forget them.',
      },
      {
        kind: "reveal",
        prompt:
          "Sound check ran long — for the third event in a row. Quick note, or template change?",
        answer:
          'Template change. "Third time in a row" means *always*, not *this time*: move the sound-check call time earlier in the template, and every future event inherits the fix. A note gets read once; a template row gets executed forever.',
      },
      {
        kind: "tip",
        text: "Spot something missing? Edit the event for a this-time fix; open the template to fix it for every future event.",
      },
    ],
    quiz: [
      {
        prompt: "What's the difference between a template and an event?",
        options: [
          "A template is read-only; an event can be edited by admins",
          "A template is the reusable blueprint for a kind of event; an event is one dated copy of it",
          "They're the same thing — 'event' is just a template with a date",
          "Templates are for big events, events are for small ones",
        ],
        answerIndex: 1,
        explanation:
          "Templates hold what's ALWAYS true for a kind of event; an event copies that structure for one date and is then freely editable — later template edits never disturb an in-flight event.",
      },
      {
        prompt:
          "This Saturday's venue has two entrances, so you need an extra welcome table. Where does that change go?",
        options: [
          "In the event — it's true this time, not always",
          "In the template — every change goes in the template",
          "Nowhere; just mention it in the group chat",
          "In a separate spreadsheet",
        ],
        answerIndex: 0,
        explanation:
          "Events hold what's true THIS time. If it turns out every venue needs it, the debrief promotes it to the template later.",
      },
      {
        prompt:
          'The debrief says "we needed trash bags." What\'s the right fix?',
        options: [
          "Write it in the debrief notes so people remember",
          "Tell the next event lead in person",
          "Add a trash-bags row to the template's supplies",
          "Buy trash bags now and store them at home",
        ],
        answerIndex: 2,
        explanation:
          "Never fix the same problem twice: learnings become TEMPLATE changes, so every future event inherits the fix automatically. That exact fix came out of Eden's real debrief.",
      },
      {
        prompt: "What happens when you create an event from a template?",
        options: [
          "You get a blank event with the template's name",
          "The template locks until the event is over",
          "The whole structure is copied and every timing offset becomes a real due date",
          "The template's past events are merged into it",
        ],
        answerIndex: 2,
        explanation:
          "Creating an event clones the template's tabs, rows, and roles, and back-calculates every due date from the event date. The copy is yours to edit; the template stays untouched.",
      },
    ],
  },

  // ── 2 · Organizers and crew ────────────────────────────────────────────────
  {
    slug: "organizers-and-crew",
    title: "Organizers and crew",
    subtitle: "Who this app is for (and who never needs it)",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Two kinds of people touch every event, and Chapter OS treats them very differently.",
      },
      {
        kind: "table",
        headers: ["Who", "What they do", "What they need"],
        rows: [
          [
            "**Organizers**",
            "Plan for weeks: own tabs, keep statuses true, make the calls",
            "This app — that's what this training is for",
          ],
          [
            "**Crew**",
            "Show up day-of to fill a role: run the welcome table, grill, play a set, shoot photos",
            "A call time, a duty, and a contact — **not** the app",
          ],
        ],
      },
      {
        kind: "p",
        text: "Crew can be volunteers (your uncle on the grill) or paid help (a photographer, a hired musician). Both live on the event's **Crew** list with an invited → confirmed status and a call time. What each crew team actually does is written in **Crew Duties** — *before* anyone is recruited into it.",
      },
      {
        kind: "rule",
        title: "Organizers plan; crew execute",
        text: "If someone's job starts and ends on event day, they're crew. They should never need to open this app — the plan hands them everything they need: their team, their contact, their call time, their duty.",
      },
      { kind: "heading", text: "The best organizers might not even be there" },
      {
        kind: "p",
        text: "A well-planned event runs without its planner standing in the park. If your event only works when you're physically present, the plan still lives in your head — which is exactly what the app exists to prevent. Strong organizers can hand a fully-planned event to the day-of team and do it consistently. And when you *do* attend, you get to actually be present instead of firefighting.",
      },
      {
        kind: "reveal",
        prompt:
          "Your friend agreed to run sound during the event. Organizer or crew?",
        answer:
          "Crew — it's a day-of role. Add them to the Crew list with a call time and their duty. If they also start planning the audio setup weeks out and owning supply rows, *now* they're an organizer too. Same human, two different hats.",
      },
    ],
    quiz: [
      {
        prompt: "Who is Chapter OS built for?",
        options: [
          "Everyone who attends the event",
          "Organizers — the people planning and helping plan",
          "Only the single event lead",
          "The venue and the vendors",
        ],
        answerIndex: 1,
        explanation:
          "The app is for organizers. Crew — people filling a day-of role — get what they need FROM the plan (call time, duty, contact) without ever opening the app.",
      },
      {
        prompt:
          "Your cousin is showing up Saturday morning to help set up chairs, then staying for the event. What are they?",
        options: [
          "An organizer — they're doing work",
          "Crew — their job starts and ends on event day",
          "Neither; setup isn't a role",
          "An event owner",
        ],
        answerIndex: 1,
        explanation:
          "If the job starts and ends on event day, they're crew: put them on the Crew list with a call time and a duty. Organizing means carrying part of the plan in the weeks before.",
      },
      {
        prompt:
          "The event ran perfectly and the person who planned it wasn't even in town. What does that mean?",
        options: [
          "The event didn't really need planning",
          "Someone else must have re-planned it day-of",
          "The plan was real: it lived in the app, not in the planner's head",
          "The organizer failed to show commitment",
        ],
        answerIndex: 2,
        explanation:
          "That's the goal state. A plan that runs without its author is proof nothing lived in anyone's head — the best organizers can do this consistently.",
      },
    ],
  },

  // ── 3 · Anatomy of an event ────────────────────────────────────────────────
  {
    slug: "anatomy-of-an-event",
    title: "Anatomy of an event",
    subtitle: "Tabs, rows, statuses, and roles",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Open any event and you'll see tabs. Each tab is one **area** of the plan — one owned slice of the work. Seven come built in, and each gets its own short section after this one:",
      },
      {
        kind: "table",
        headers: ["Tab", "What it holds"],
        rows: [
          ["**Tasks**", "The master to-do list"],
          ["**Comms Schedule**", "Every message the event sends"],
          ["**Run of Show**", "The minute-by-minute day-of program"],
          ["**Crew Duties**", "What each crew team does"],
          ["**Supplies & Logistics**", "Every physical item + the site map"],
          ["**Permits**", "Permission paperwork"],
          ["**Debrief**", "What you learned, after"],
        ],
      },
      {
        kind: "p",
        text: "A chapter can add custom tabs (a merch stand, a food operation) and toggle off tabs an event doesn't need. Every tab works the same way: it's a table of **rows**. A row is one unit of work — a task, a message, a supply item — and every row has a **title**, a **status**, and a **person it resolves to**.",
      },
      {
        kind: "try_status",
        title: "Confirm porta-potty vendor",
        options: [
          { value: "not_started", label: "Not started", color: "red" },
          { value: "in_progress", label: "In progress", color: "amber" },
          { value: "done", label: "Done", color: "green" },
        ],
        terminal: "done",
        caption:
          "Every row on every tab works exactly like this chip. Statuses aren't bookkeeping — the event's readiness numbers are computed from them, so a stale status is a small lie the whole team steers by.",
      },
      { kind: "heading", text: "Roles: assign hats, then people" },
      {
        kind: "p",
        text: "Templates attach work to **roles** — Event Lead, Comms Lead, Logistics Lead, Production Lead — and each event puts one person in each hat. That's why a template written in New York works in Austin: the work follows the hat, not the human. **One person per role, per event** — helpers are crew; accountability is singular.",
      },
      {
        kind: "p",
        text: "So who's on the hook for any given row? Follow the chain:",
      },
      { kind: "try_chain" },
      {
        kind: "rule",
        title: "Every row ends at one human",
        text: "Row owner → row's role → that role's person → the tab's owner → the event owner. If the chain dead-ends, the row is **unowned** — and unowned work doesn't get argued about, it just silently doesn't happen.",
      },
    ],
    quiz: [
      {
        prompt: "What is a row, on any tab?",
        options: [
          "A comment about the event",
          "One unit of work with a title, a status, and a person it resolves to",
          "A read-only line the template wrote",
          "A message to the crew",
        ],
        answerIndex: 1,
        explanation:
          "Every tab is a table of rows, and every row — task, message, supply, permit — carries the same three things: title, status, accountable human.",
      },
      {
        prompt: "Why do templates assign work to roles instead of people?",
        options: [
          "Because names change too often to store",
          "So the same template works with any team — the work follows the hat, not the human",
          "Roles are cheaper to store",
          "So nobody feels personally responsible",
        ],
        answerIndex: 1,
        explanation:
          "Roles before people: the template says 'Comms Lead does this', and each event puts one person in that hat. Portable across cities, legible when people swap.",
      },
      {
        prompt:
          "Two capable friends both want to co-own the Run of Show. What does the app expect?",
        options: [
          "Assign both — more owners, more done",
          "One holds the role and is accountable; the other helps as crew",
          "Split the tab in two",
          "Let the assistant own it",
        ],
        answerIndex: 1,
        explanation:
          "One person per role per event. Shared ownership is how 'I thought you had it' happens — helpers are crew, accountability is singular.",
      },
      {
        prompt: "A row has no owner and no role. What happens to it?",
        options: [
          "It's optional, so nothing needs to happen",
          "It escalates to the chapter admin",
          "It lands on the event owner — the end of the chain — until they hand it to someone",
          "It gets deleted automatically",
        ],
        answerIndex: 2,
        explanation:
          "The accountability chain always terminates at the event owner. Anything that falls through every other hand is theirs until they place it — otherwise it's unowned, and unowned work silently fails.",
      },
    ],
  },

  // ── 4 · Being an owner ─────────────────────────────────────────────────────
  {
    slug: "being-an-owner",
    title: "Being an owner",
    subtitle: "Accountability, oversight, and building for your own absence",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "You've seen that every row, tab, and event resolves to an owner. Now the part nobody tells you when you get handed one: **doing work and owning work are two different jobs.** Most people meet Chapter OS as a doer — rows with their name on them. Owning is the graduation: you're no longer measured by the rows you finish, but by whether the *whole thing* happens.",
      },
      {
        kind: "table",
        headers: ["", "A doer", "An owner"],
        rows: [
          [
            "**Cares about**",
            "Their rows: execute, update the status, flag blockers",
            "The whole area or event: every needed row exists, has an owner, has timing",
          ],
          [
            "**Success is**",
            "\"My work is done and my statuses are true\"",
            "\"It would happen even if I did nothing else today\"",
          ],
          [
            "**When something's missing**",
            "Tells the owner",
            "Is the person the gap lands on — finds it, rows it, places it",
          ],
        ],
      },
      {
        kind: "rule",
        title: "If it doesn't happen, it's on you",
        text: "That's the whole definition. You can delegate every piece of the work; you can never delegate the accountability. But delegation done right CREATES accountability at each layer: someone handed a clear row — details, timing, owner — owns getting it done on their own. Layers of accountability, not layers of excuses.",
      },
      { kind: "heading", text: "Oversight is a dial, not a fixed job" },
      {
        kind: "p",
        text: "How much active oversight you owe depends entirely on your team. With strong role-holders who keep their statuses true, owning is light: read the rings, scan What's-next, handle the exceptions. With a team that updates the plan inconsistently, the dial turns up — you walk the tabs, ask the humans what's actually true, and fix the plan until it matches reality. The rings only steer you if someone makes sure they're honest; below the best teams, that someone is you.",
      },
      {
        kind: "reveal",
        prompt:
          "You own the event. At T-8 the Comms tab says the announcement is still 'Drafted' — and the Comms Lead hasn't touched a status in a week. What's the owner move?",
        answer:
          "Turn the dial up, through the person: ask the Comms Lead what's true, get the statuses honest, and unblock them if something's stuck. Don't silently do it yourself (that teaches the plan to lie and the lead to lean), and don't just wait (the outcome is still yours). Accountability flows through people — but it ends at you.",
      },
      { kind: "heading", text: "The owner's test: plan yourself out" },
      {
        kind: "p",
        text: "Read the plan as if you won't be there. If every role-holder reasonably follows their rows — the timing, the details, the duties — **does the event happen?** Every place the answer wobbles is a gap: a missing row, an unowned row, a detail that lives only in your head. Fix the plan, not the moment. Building for your own absence is not a stretch goal; it's what owning means here.",
      },
      {
        kind: "p",
        text: "It's also how you carve up the work: shape the plan into **roles that make sense**, then put people in them. Usually an event lead, someone on comms, someone on logistics; add production or more as the event grows and as you have hands. Each role gets whole areas — real slices someone can own — not loose errands. One person per role: helpers are crew, accountability is singular.",
      },
      {
        kind: "tip",
        text: "Ask the assistant to run your test for you: \"If I disappeared today, what breaks? What's unowned, undated, or only in my head?\" It reads the live rows and answers honestly.",
      },
    ],
    quiz: [
      {
        prompt: "What changes when you go from doing rows to OWNING an area or event?",
        options: [
          "You do all the rows yourself now",
          "You're accountable that the whole thing happens — every row exists, resolves to someone, and gets done",
          "You only attend the meetings",
          "Nothing — owner is a label for the busiest person",
        ],
        answerIndex: 1,
        explanation:
          "A doer is measured by their rows; an owner by the outcome. Owning means the gaps land on you: if something needed doesn't have a row, an owner, and timing, finding and fixing that is your job.",
      },
      {
        prompt:
          "Your role-holders keep every status true and nothing sits unowned. How much active oversight do you owe?",
        options: [
          "The same as always — walk every tab daily no matter what",
          "Little: read the rings and What's-next, handle exceptions — a strong team turns the dial down",
          "None — a good team means the owner can check out",
          "More — good teams need more supervision",
        ],
        answerIndex: 1,
        explanation:
          "Oversight is a dial, not a fixed job. It scales with how consistently the team keeps the plan true — but it never reaches zero: someone has to verify the rings are honest, and that someone is the owner.",
      },
      {
        prompt: "What is the owner's test of a plan?",
        options: [
          "Is every row marked Done?",
          "Did the budget come in under?",
          "If I weren't there and everyone reasonably followed their rows and roles, would this event happen?",
          "Has every teammate opened the app this week?",
        ],
        answerIndex: 2,
        explanation:
          "Read the plan as if you'll be absent. Every place it would wobble without you is a gap — a missing row, an unowned row, a detail only in your head. Owners build for their own absence.",
      },
      {
        prompt:
          "You handed the Comms area to a lead with clear duties, details, and timing. A message never goes out. Who's accountable?",
        options: [
          "Nobody — plans fail sometimes",
          "Only you — delegation keeps all accountability with the owner",
          "Only the comms lead — you delegated it away",
          "Both, at different layers: the lead owns their area's outcome, and the event is still on you",
        ],
        answerIndex: 3,
        explanation:
          "Delegation transfers the work and creates accountability at the new layer — someone given the right information owns delivering on it. But it never removes yours: every layer answers for its slice, and the event ends at the owner.",
      },
      {
        prompt: "How does an owner carve an event into roles?",
        options: [
          "One role per task, so nothing is shared",
          "Start with event lead + comms + logistics, add roles as the event and the available hands grow — whole areas per role, one person per role",
          "Everyone shares all the roles for flexibility",
          "Roles are only for events over 100 people",
        ],
        answerIndex: 1,
        explanation:
          "Shape the work into role-sized slices someone can genuinely own — the lightweight trio covers most events, and bigger events with more hands add production and beyond. Helpers are crew; accountability stays singular.",
      },
    ],
  },

  // ── 5 · Timing ─────────────────────────────────────────────────────────────
  {
    slug: "timing-and-offsets",
    title: "Timing that moves with the date",
    subtitle: "Offsets, due dates, and real-world lead times",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: 'Put real dates in a spreadsheet, then move the event a week — everything is wrong. Chapter OS stores timing as an **offset** instead: "10 days before the event." The shorthand you\'ll see is T-notation: **T-10** is 10 days before, **T-0** is event day, **T+2** is two days after.',
      },
      { kind: "try_offset", eventDateLabel: "Worship With Strangers" },
      {
        kind: "p",
        text: "Where do the numbers come from? **Your template.** Announce at T-14, lock volunteers by T-10, pack supplies by T-1 — those are the proven defaults our worship templates ship with, distilled from real events. They're the template's earned opinion, not the app's law. Planning something smaller? Change the number. New number works better? Change the *template*.",
      },
      {
        kind: "p",
        text: "And horizons scale with the event. A flagship gathering starts **months** out — venues and permits can need T-60 or more. A backyard party still wants two weeks. Treat **two weeks as the floor** for planning anything involving other people, not as the standard length of a plan.",
      },
      {
        kind: "rule",
        title: "A task without timing is invisible",
        text: "Due dates come from offsets, and reminder emails come from due dates. A row with no timing never lands on anyone's list — give every task an offset, even a rough one.",
      },
      { kind: "heading", text: "The one thing a reschedule can't fix" },
      {
        kind: "p",
        text: "Move the date and every derived due date moves with it — that's the point. But the outside world doesn't compress: a park permit still takes weeks, a custom order still ships in days. After any date change, re-check anything with a real-world lead time.",
      },
      {
        kind: "story",
        title: "Eden, 2026",
        text: "Eden applied for its park permit with plenty of runway and *still didn't get it* — survivable only because the plan had slack and a written fallback. Anything on someone else's clock starts as early as possible, with a plan B next to it.",
      },
      {
        kind: "tip",
        text: "Reschedule from **Details** in the event header — every derived due date moves with the date. Then re-check permits and orders yourself; calendars move, lead times don't.",
      },
    ],
    quiz: [
      {
        prompt: "The event moves from June 7 to June 14. What happens?",
        options: [
          "Nothing — dates and tasks are independent",
          "Every offset-derived due date shifts automatically, but lead-time work (permits, orders) needs a manual re-check",
          "All tasks reset to Not started",
          "Only day-of tasks move",
        ],
        answerIndex: 1,
        explanation:
          "Offsets re-derive due dates automatically — that's why the app stores timing as offsets. But permits and shipping obey the real world, not your calendar, so feasibility gets re-checked after every reschedule.",
      },
      {
        prompt: 'Your template says "announce at T-14" but your event is a small pop-up planned 10 days out. What do you do?',
        options: [
          "Cancel — the template's rule can't be met",
          "Announce at T-14 anyway by backdating",
          "Change the offset on your event; if the new timing works well, improve the template",
          "Skip the announcement entirely",
        ],
        answerIndex: 2,
        explanation:
          "Template numbers are earned defaults, not laws of the app. Events adapt freely — and good adaptations flow back into the template so it gets smarter.",
      },
      {
        prompt: "Why does every task need an offset, even a rough one?",
        options: [
          "The app refuses to save rows without one",
          "Offsets drive due dates, and due dates drive reminders — an untimed task never lands on anyone's list",
          "It makes the grid look complete",
          "Offsets are required for the budget rollup",
        ],
        answerIndex: 1,
        explanation:
          "A task without timing is invisible: no due date, no reminder, no place in anyone's day. Even a rough offset puts it on the radar.",
      },
      {
        prompt: "What did Eden's park permit teach the playbook?",
        options: [
          "Permits are optional for outdoor events",
          "Apply as early as possible and write a fallback — approval is never in your hands",
          "Permits only take a day or two",
          "Only paid events need permits",
        ],
        answerIndex: 1,
        explanation:
          "Eden applied in time and still got denied — survivable only because of slack and a written plan B. Lead-time work starts at kickoff and always carries a fallback.",
      },
    ],
  },

  // ── 6 · The four phase rings ───────────────────────────────────────────────
  {
    slug: "phase-rings",
    title: "The four rings",
    subtitle: "Pre-plan, Planning, Day-of, Post — and staying on pace",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every event header shows four rings. They're computed from your real rows — an honesty meter, not a vibe — and each one answers a different question:",
      },
      {
        kind: "table",
        headers: ["Ring", "The question", "What moves it"],
        rows: [
          [
            "**Pre-plan**",
            "Is the event set up to be planned?",
            "Roles filled, area owners assigned, template-marked cells checked off, Comms + Permits marked ready",
          ],
          [
            "**Planning**",
            "Is the prep on track?",
            "Every row due *before* the event (T-minus tasks, messages, permits, supply buying/ordering) + locking Run of Show, Crew Duties, Supplies",
          ],
          [
            "**Day-of**",
            "Will the day itself run?",
            "Supplies checked off the Packing checklist, Crew Duties, day-of rows",
          ],
          [
            "**Post**",
            "Did we close the loop?",
            "Debrief rows dispatched, anything dated after the event (T-plus)",
          ],
        ],
      },
      {
        kind: "p",
        text: "The sorting is automatic: a row's tab and timing decide its ring. Debrief rows are always Post. Crew Duties are always Day-of. Supplies count twice, because every item is two jobs: *getting it* (order, buy, pull from storage) follows the item's timing — that's Planning work, weeks out — while *packing it* always counts toward Day-of, even when you pack early. Everything else follows its offset — before the event feeds Planning, on the day feeds Day-of, after feeds Post. **Pre-plan is different**: it isn't statuses at all, but the explicit setup checklist — people in roles, owners on areas, and the specific cells your template flagged for a deliberate check-off.",
      },
      { kind: "heading", text: "Am I where I should be?" },
      {
        kind: "p",
        text: "A percentage alone can't tell you if you're in trouble — 40% planned is great at two months out and a crisis at three days. So each ring carries a pace check built on one blunt question: **is anything in this phase overdue?** Nothing overdue → a green **“✓ on pace”**. Something overdue → an amber **“▲ 3 overdue”** — the very same rows the What's-next list flags, counted per ring. A dashed tick on the ring marks your **baseline**: your score with every overdue row cleared — and it moves up with you when you finish things early, so working ahead always shows.",
      },
      {
        kind: "rule",
        title: "The rings only tell the truth you tell them",
        text: "Every number here is computed from row statuses and due dates. A stale status doesn't just lie about one row — it corrupts the pace math the whole team steers by. Update statuses the day things happen.",
      },
      {
        kind: "try_ready",
        criteria: [
          "All rows at a terminal status",
          "Every row has an owner",
          "Pre-plan cells checked",
        ],
      },
      {
        kind: "tip",
        text: "Tap any ring on the event header — the tabs that feed it pulse, answering \"what do I do to move this number?\"",
      },
    ],
    quiz: [
      {
        prompt: "What makes the Pre-plan ring different from the other three?",
        options: [
          "It's the only one an admin can edit",
          "It tracks the explicit setup checklist — roles, area owners, flagged cells — not row statuses",
          "It's computed from the budget",
          "It only appears on large events",
        ],
        answerIndex: 1,
        explanation:
          "Planning/Day-of/Post are computed from row statuses and timing. Pre-plan is the deliberate check-off layer: people in roles, owners on areas, and the cells your template marked for explicit confirmation.",
      },
      {
        prompt: "Which ring does a Debrief row feed?",
        options: [
          "Planning",
          "Day-of",
          "Post — always",
          "Whichever the owner picks",
        ],
        answerIndex: 2,
        explanation:
          "The sorting is automatic by tab and timing: Debrief rows are always Post, Crew Duties always Day-of, supplies split their two jobs (buying feeds Planning, packing feeds Day-of), and everything else follows its offset.",
      },
      {
        prompt: "Your Planning ring reads 20% with \"▲ 6 overdue\" under it. What does that mean?",
        options: [
          "The ring is broken",
          "You've done 20% of the whole event",
          "Six of that phase's rows are past due and not done — the same rows the What's-next list flags — and clearing them is today's job",
          "The template requires 6 more tasks before you can continue",
        ],
        answerIndex: 2,
        explanation:
          "The pace check is blunt on purpose: anything overdue in a phase and its ring says so, with the count. Ring and What's-next list read the same rows, so they always agree.",
      },
      {
        prompt: "Why does a stale status matter more than it seems?",
        options: [
          "It doesn't — statuses are just labels",
          "The rings and pace math are computed from statuses, so one stale row corrupts the numbers everyone steers by",
          "Stale statuses get auto-deleted",
          "It blocks other people from editing the row",
        ],
        answerIndex: 1,
        explanation:
          "The rings are an honesty meter. They only work if owners keep statuses true the day things happen — that's why 'the area tells the truth' is expectation #1.",
      },
    ],
  },

  // ── 7 · Tasks ──────────────────────────────────────────────────────────────
  {
    slug: "tab-tasks",
    title: "Tasks",
    subtitle: "The master to-do list — and what does NOT go on it",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The **Tasks** tab is the event's master to-do list — the one tab that sees everything. Default owner: the Event Lead. A row with no owner and no role isn't nobody's — it's the **tab owner's**, so leaving Owner blank on a task is assigning it to the Event Lead.",
      },
      {
        kind: "p",
        text: "**When to use it:** anything that must happen that isn't a message (Comms), a physical item (Supplies), a person to recruit (Crew Duties), paperwork (Permits), or a day-of segment (Run of Show). Book the venue, confirm the worship leader, schedule the planning meeting. Not sure where something goes? Put it in Tasks — you can always move it.",
      },
      { kind: "heading", text: "The most common mistake: tasks that aren't tasks" },
      {
        kind: "p",
        text: "Most \"tasks\" that clog this tab are really rows for another area, wearing a to-do costume. The tell: the specialist tab tracks things a task row can't — cost and packing for supplies, confirmations and call times for crew, deadlines and documents for permits.",
      },
      {
        kind: "table",
        headers: ["Sounds like a task…", "Where it actually lives"],
        rows: [
          [
            '"Buy lawn games" / "Order napkins"',
            "**Supplies & Logistics** — a physical item, with source, cost, link, and a have-it-by date",
          ],
          [
            '"We need a videographer"',
            "**Crew Duties** — write the duty on the Content team, then fill the slot with a volunteer or a paid vendor",
          ],
          [
            '"Post the announcement"',
            "**Comms Schedule** — a message, with audience, channel, and timing",
          ],
          [
            '"Secure the park permit"',
            "**Permits** — paperwork on someone else's clock, with a deadline and the document attached",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Write it once, where it lives",
        text: "A task that restates a row on another tab is sprawl: two copies of one fact means one of them is stale, and soon nobody trusts either. If the work is already a supply, comms, crew, or permit row, that row IS the plan — don't shadow it with a task.",
      },
      {
        kind: "reveal",
        prompt:
          '"We need someone to film the event." Your finger is hovering over + Add row on Tasks. What do you actually do?',
        answer:
          "Open Crew Duties instead. Write the duty on the Content team (\"shoot recap clips: worship, crowd, the gospel moment\"), then fill the slot — a friend who volunteers, or a hired videographer as paid crew with an amount. An unfilled crew slot is the honest signal that recruiting isn't done; a task named \"find videographer\" just hides it.",
      },
      {
        kind: "p",
        text: 'For the rows that DO belong here: the task, **details rich enough for a stranger**, a status, timing, and who it resolves to. "Sound permit via precinct officer, ~3 days prior, permit holder must attend" is worth ten "get sound permit" rows — details are how the reason survives the person.',
      },
      {
        kind: "try_status",
        title: "Confirm the worship leader",
        options: [
          { value: "not_started", label: "Not started", color: "red" },
          { value: "in_progress", label: "In progress", color: "amber" },
          { value: "done", label: "Done", color: "green" },
        ],
        terminal: "done",
        caption:
          "Update statuses the day things happen, not the night before the event — the readiness numbers everyone steers by are computed from these.",
      },
      {
        kind: "rule",
        title: "One row per promise",
        text: 'If someone said "I\'ll handle it," there\'s a row with their name on it. No row, no plan — just a vibe.',
      },
      {
        kind: "tip",
        text: "Rows sort themselves by due date, so reading top-to-bottom is reading the timeline: **overdue rows are flagged red**, and finished rows whose dates have passed fade out. The red band is where your problems live.",
      },
      {
        kind: "tip",
        text: "**Me view** filters every tab down to just your rows — the fastest answer to \"what's mine this week?\"",
      },
    ],
    quiz: [
      {
        prompt: "Which of these does NOT belong on the Tasks tab?",
        options: [
          '"Book the venue walkthrough"',
          '"Buy 100 red napkins"',
          '"Schedule the planning meeting"',
          '"Confirm the rain plan"',
        ],
        answerIndex: 1,
        explanation:
          "Buying things is a Supplies & Logistics row — that tab tracks what a task can't: source, cost, link, quantity, a have-it-by date, and packing. Booking, scheduling, and confirming are true tasks.",
      },
      {
        prompt: '"We need a videographer." What\'s the right move?',
        options: [
          'Add a task: "Find videographer"',
          "Write the duty on Crew Duties' Content team, then fill the slot with a volunteer or a paid vendor",
          "Mention it in the group chat",
          "Add it to the Comms Schedule",
        ],
        answerIndex: 1,
        explanation:
          "Recruiting lives in Crew Duties: the duty says what the job is, and the slot tracks who fills it — volunteer or paid, with confirmation, call time, and (for vendors) an amount that rolls into the budget.",
      },
      {
        prompt:
          'Tasks has a row "Secure the sound permit" and the Permits tab has a sound-permit row. What\'s wrong?',
        options: [
          "Nothing — redundancy is safety",
          "The task should have an owner too",
          "The same fact lives twice, so one copy WILL go stale — the Permits row is the plan; delete the shadow task",
          "The permit row should move to Tasks",
        ],
        answerIndex: 2,
        explanation:
          "Write it once, where it lives. Duplicated rows drift apart, and the team stops trusting both. The specialist tab's row carries the deadline and the document — it's the single source of truth.",
      },
      {
        prompt: 'Why is "Sound permit via precinct officer, ~3 days prior, holder must attend" a better row than "Get sound permit"?',
        options: [
          "It's longer, so it looks more thorough",
          "Details rich enough for a stranger mean the task survives the person who knew how",
          "Short titles break the grid",
          "The assistant requires full sentences",
        ],
        answerIndex: 1,
        explanation:
          "The plan must be runnable with zero tribal knowledge. Details carry the HOW and the WHY so anyone can pick the row up cold.",
      },
      {
        prompt: "A task row has no owner and no role. Whose is it?",
        options: [
          "Nobody's — it's optional",
          "The tab owner's — for Tasks, the Event Lead",
          "The last person who edited it",
          "The assistant's",
        ],
        answerIndex: 1,
        explanation:
          "Blank isn't neutral: an unowned row defaults to whoever owns the tab. Same rule on every tab — which is why area owners fill in owners, or accept that everything blank is theirs.",
      },
    ],
  },

  // ── 8 · Comms Schedule ─────────────────────────────────────────────────────
  {
    slug: "tab-comms",
    title: "Comms Schedule",
    subtitle: "Every message, planned like a task",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Comms is not \"post about it sometime.\" Every message the event sends is a row, and each column answers one question about it. Default owner: the Comms Lead — a comms row with no owner is theirs by default.",
      },
      {
        kind: "table",
        headers: ["Column", "The question it answers"],
        rows: [
          ["**Comm**", "What is this message? (\"Announcement\", \"T-1 call-time reminder\")"],
          ["**Status**", "Not started → Drafted → Scheduled → **Sent** (the only terminal state)"],
          ["**Timing / Date**", "When does it go out? An offset (T-7) that derives the real date"],
          ["**Channel**", "Where does it post — IG, the iMessage group, email, Slack?"],
          ["**Audience**", "Who is it for — leaders, volunteers, attendees, the public?"],
          ["**Owner**", "Who sends it. Blank = the Comms Lead, the tab's owner"],
          ["**Notes / copy**", "The actual message text lives HERE — not in someone's drafts folder"],
        ],
      },
      {
        kind: "p",
        text: "**When to use it:** the announcement, the volunteer ask, reminders, day-of \"here's the pin, here's how to find us\", and thank-yous after. If it reaches people outside the planning team, it's a row here.",
      },
      {
        kind: "try_status",
        title: "Announce the event on socials",
        options: [
          { value: "not_started", label: "Not started", color: "red" },
          { value: "drafted", label: "Drafted", color: "amber" },
          { value: "scheduled", label: "Scheduled", color: "blue" },
          { value: "sent", label: "Sent", color: "green" },
        ],
        terminal: "sent",
        caption:
          "Sent is the terminal state — a drafted message helps nobody find the park.",
      },
      {
        kind: "p",
        text: "Repetition is a feature, not spam. Our templates remind volunteers at T-7, T-3, *and* T-1 — that cadence is how twenty people show up at the same spot at the same time. And thank-yous are planned rows too (day-of to crew, T+1 to attendees): gratitude is a retention strategy, not an afterthought.",
      },
      {
        kind: "rule",
        title: "If it isn't scheduled, it doesn't get sent",
        text: "Every audience — public, attendees, crew, leaders — should hear from you in every phase. A volunteer who hears nothing between the ask and event day is a volunteer who doesn't show.",
      },
      {
        kind: "tip",
        text: "One hard gate worth memorizing: **never announce a venue that isn't locked.** The announcement row waits on the venue row.",
      },
    ],
    quiz: [
      {
        prompt: "What makes something a Comms row instead of a Task?",
        options: [
          "It costs money",
          "It reaches people outside the planning team",
          "It happens on event day",
          "The comms lead created it",
        ],
        answerIndex: 1,
        explanation:
          "Comms rows are messages: announcement, asks, reminders, thank-yous. Each carries audience + channel + timing + the actual copy.",
      },
      {
        prompt: "Volunteers get reminders at T-7, T-3, AND T-1. Why?",
        options: [
          "The app sends them automatically no matter what",
          "Repetition is how twenty people actually show up at the same place and time",
          "It fills out the schedule so it looks planned",
          "One reminder is legally insufficient",
        ],
        answerIndex: 1,
        explanation:
          "That cadence is earned knowledge from real events. Repetition isn't spam — it's the difference between 'invited' and 'present'.",
      },
      {
        prompt: "The venue isn't confirmed yet, but the announcement post is ready. Send it?",
        options: [
          "Yes — momentum matters most",
          "Yes, but delete it if the venue falls through",
          "No — never announce an unconfirmed venue; the announcement waits on the venue lock",
          "Only if the event is under two weeks out",
        ],
        answerIndex: 2,
        explanation:
          "This is one of the few hard gates: announcing an unlocked venue means potentially re-announcing a move to your whole audience — or worse, people showing up at the wrong park.",
      },
      {
        prompt: "Where does the actual text of a message live?",
        options: [
          "In the owner's drafts folder",
          "In the row's Notes / copy column",
          "In the group chat, pinned",
          "In a linked Google Doc, always",
        ],
        answerIndex: 1,
        explanation:
          "The copy lives on the row, so anyone can send it — including whoever covers for you. A message that lives in your drafts dies with your availability. (And an unowned comms row belongs to the Comms Lead, the tab's owner.)",
      },
    ],
  },

  // ── 9 · Run of Show ────────────────────────────────────────────────────────
  {
    slug: "tab-run-of-show",
    title: "Run of Show",
    subtitle: "The day itself, minute by minute",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Run of Show is the program of the day. Its rows are **segments**, timed in minutes from event start: load-in at −60, sound check at −30, huddle at −10, worship set at 0, strike at the end. Default owner: the Production Lead.",
      },
      {
        kind: "p",
        text: "**When to use it:** everything that happens on the day, in order — including the unglamorous parts. Setup, sound check, the huddle, and strike are real segments with real owners, because they're where the day actually goes wrong.",
      },
      {
        kind: "rule",
        title: "Every segment has one named owner",
        text: '"All" is acceptable only for arrival, setup, and strike. A segment owned by everyone is owned by no one — and the awkward silence while people look at each other happens in front of your guests.',
      },
      {
        kind: "reveal",
        prompt:
          "Guests have arrived and it's time to shift from background music into the worship set. Who makes that call?",
        answer:
          "Whoever owns that segment — by name, on the row. If the row says a team or \"all\", nobody moves. The run of show exists so day-of needs zero improvisation about *who*.",
      },
      {
        kind: "p",
        text: "Call times live here too — work backwards from start: team arrival, setup, sound check, doors. Real-event learning: arrive *earlier* than feels necessary; in a public space you don't reserve your spot, you occupy it.",
      },
      {
        kind: "tip",
        text: "Lock the run of show a few days out — our templates lock at T-3, because the T-3 and T-1 reminder messages quote its call times. An unlocked run of show means reminders quoting fiction.",
      },
    ],
    quiz: [
      {
        prompt: "How are Run of Show rows timed?",
        options: [
          "In days before the event, like tasks",
          "In minutes from event start — negative before, positive after",
          "They aren't timed; order is enough",
          "By exact clock times typed by hand",
        ],
        answerIndex: 1,
        explanation:
          "Segments carry minute offsets from start (−60 = an hour before). Move the start time and the whole day's math holds.",
      },
      {
        prompt: "Which of these should be a Run of Show segment?",
        options: [
          "Ordering the food (a week before)",
          "The announcement post",
          "Setup and strike",
          "The debrief meeting",
        ],
        answerIndex: 2,
        explanation:
          "Everything that happens on the day is a segment — especially setup, sound check, huddle, and strike, because that's where days actually go wrong.",
      },
      {
        prompt: "Why lock the run of show a few days before the event?",
        options: [
          "Because printing takes three days",
          "Reminder messages quote its call times — an unlocked run of show means reminders quoting fiction",
          "The app locks it automatically anyway",
          "So the venue can approve it",
        ],
        answerIndex: 1,
        explanation:
          "The T-3/T-1 reminders pull call times from these rows. That's why our templates lock the run of show at T-3 — the number is a consequence, not a superstition.",
      },
    ],
  },

  // ── 10 · Crew Duties ────────────────────────────────────────────────────────
  {
    slug: "tab-crew-duties",
    title: "Crew Duties",
    subtitle: "Who's coming day-of, and what each team does",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "This tab is the day-of people system, in two halves. The **Crew list**: every volunteer and paid helper, with their team, an invited → confirmed status, and a call time. And the **duty rows**: what each team actually does — \"Welcome ×6: greet, direct, hand out connect cards.\" Default owner: the Comms Lead — duty rows with no owner are theirs.",
      },
      { kind: "heading", text: "How to build it, in order" },
      {
        kind: "bullets",
        items: [
          "**1 · Name your teams.** The Team column's options ARE the event's team list. Teams are day-of *functions*: Welcome, Food & Bev, Production, Content, Prayer — the stations your event needs humans at. (\"Budget\" and \"Venue research\" are planning workstreams, not crew teams.)",
          "**2 · Write each team's duties.** One row per expectation, with details of what done looks like. This is the job description someone says yes to.",
          "**3 · Fill the slots.** Recruit people INTO teams — a friend who volunteers and a hired videographer go on the same crew list. Paid crew carry an amount and an unpaid → paid status that rolls into the budget.",
          "**4 · Chase to confirmed, with call times.** Invited is a maybe; only confirmed counts. Every confirmed crew member gets a call time.",
        ],
      },
      {
        kind: "rule",
        title: "Needing a person = a duty + an open slot, not a task",
        text: '"We need a videographer" is not a to-do — it\'s an unfilled role. Write the duty (Content team: "shoot recap clips"), then fill it with a volunteer or a vendor. The open slot IS the honest status of your recruiting; a task named "find someone" just hides the hole.',
      },
      {
        kind: "try_status",
        title: "Jordan — Welcome team",
        options: [
          { value: "invited", label: "Invited", color: "gray" },
          { value: "confirmed", label: "Confirmed", color: "green" },
        ],
        terminal: "confirmed",
        caption:
          "Invited is a maybe. A crew list full of 'invited' three days out is a list of holes — chase confirmations early.",
      },
      {
        kind: "rule",
        title: "Write duties before you recruit",
        text: "Recruiting against unwritten expectations gets you warm bodies with no idea what to do. Write the team duties first, then post the ask — and every crew member knows five things before they arrive: their team, their contact, their call time, what to wear, what to bring.",
      },
      {
        kind: "p",
        text: "Remember: crew never need the app. The briefing page carries their five things out to them — the plan reaches the crew; the crew never has to reach into the plan.",
      },
      {
        kind: "reveal",
        prompt:
          "It's five days out. Your crew list shows 8 people: 3 confirmed, 5 invited. How worried are you?",
        answer:
          "Worried enough to act today. Invited ≠ confirmed — you have 3 crew and 5 maybes. Chase every 'invited' now, while there's still time to recruit replacements. Our templates treat unconfirmed crew inside T-10 as a fire.",
      },
    ],
    quiz: [
      {
        prompt: "What are the two halves of the Crew Duties tab?",
        options: [
          "A budget and a schedule",
          "The crew list (who, with status + call time) and duty rows (what each team does)",
          "Organizers and attendees",
          "Invites and thank-yous",
        ],
        answerIndex: 1,
        explanation:
          "WHO is coming lives on the crew list; WHAT each team does lives in the duty rows. Together they're everything the day-of people system needs.",
      },
      {
        prompt: "Which of these is a crew TEAM you'd expect on this tab?",
        options: [
          "Welcome",
          "Budget",
          "Venue research",
          "Permits",
        ],
        answerIndex: 0,
        explanation:
          "Teams are day-of functions — Welcome, Food & Bev, Production, Content, Prayer: stations that need humans at the event. Budget, venue research, and permits are planning work that lives on other tabs, owned by organizers.",
      },
      {
        prompt: "Where does a paid photographer belong?",
        options: [
          "On the Tasks tab as a to-do",
          "On the crew list, with an amount and a payment status that rolls into the budget",
          "In a separate vendors spreadsheet",
          "They're an organizer",
        ],
        answerIndex: 1,
        explanation:
          "Volunteers and paid help are both crew — same list, same call times. Paid engagements add an amount and unpaid → paid tracking into the budget rollup.",
      },
      {
        prompt: "Why do duties get written BEFORE the volunteer ask goes out?",
        options: [
          "The app blocks recruiting until they exist",
          "So you recruit people into specific, known jobs instead of collecting warm bodies with no idea what to do",
          "Because duties can't be edited later",
          "To make the tab look complete",
        ],
        answerIndex: 1,
        explanation:
          "Expectations before recruitment: people say yes to a clear job and show up knowing their team, contact, call time, dress, and gear.",
      },
      {
        prompt: "What does 'invited' mean on the crew list?",
        options: [
          "They're coming",
          "They're a maybe — only 'confirmed' counts",
          "They've been paid",
          "They declined",
        ],
        answerIndex: 1,
        explanation:
          "Invited ≠ confirmed. A list of 'invited' near event day is a list of holes — chase confirmations early enough to recruit replacements.",
      },
    ],
  },

  // ── 11 · Supplies & Logistics ───────────────────────────────────────────────
  {
    slug: "tab-supplies",
    title: "Supplies & Logistics",
    subtitle: "Every physical thing: get it, know where it is, pack it",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Every physical item the event needs is a row. Default owner: the Logistics Lead — an item with no owner is theirs to bring. Each column carries one fact the day depends on:",
      },
      {
        kind: "table",
        headers: ["Column", "The question it answers"],
        rows: [
          ["**Status**", "How close is it to in-hand? Pull from storage / need to order / need to buy / ordered → **Have it**"],
          ["**Timing / Due**", "When must you HAVE it? Orders need shipping time — set it weeks out, not T-1"],
          ["**Source**", "Where does it come from — and once you have it, where does it LIVE now?"],
          ["**Packed in**", 'Which container? "Green luggage" beats "somewhere"'],
          ["**Qty · Cost · Link**", "How many, what it costs (feeds the budget), where to re-order it"],
          ["**Owner**", "Who's bringing it. Blank = the Logistics Lead"],
        ],
      },
      { kind: "heading", text: "Every item is two jobs on two clocks" },
      {
        kind: "p",
        text: "**Getting it** happens early: online orders go out weeks ahead (shipping is a lead time like any other), store runs a few days out. That's planning work, and the Timing column is its deadline. **Packing it** happens at the end — everything in hand by T-1, checked into its container. Getting feeds the Planning ring; packing feeds the Day-of ring, even when you pack early.",
      },
      {
        kind: "try_status",
        title: "Battery (main speaker)",
        options: [
          { value: "pull_from_storage", label: "Pull from storage", color: "blue" },
          { value: "ordered", label: "Ordered", color: "amber" },
          { value: "have_it", label: "Have it", color: "green" },
        ],
        terminal: "have_it",
        caption:
          "Status ends at Have it — in your hands, not \"on the way\". This battery leaves storage early enough to charge at home, because there's no charger in storage. (\"VERY IMPORTANT\" in the original checklist, learned the hard way.)",
      },
      {
        kind: "rule",
        title: "Packing is a checklist, not a status",
        text: "Whether something is packed is tracked in ONE place: the Packing checklist, where items group by container and get checked in (and back out at strike). Status stops at Have it — a status can claim \"packed\" while the trunk says otherwise, which is exactly why we don't track it there.",
      },
      {
        kind: "p",
        text: "The moment you HAVE something — bought, delivered, or borrowed — update **Source** and notes with where it lives: *\"with Maya\"*, *\"Sam's garage\"*, *\"fridge at Mom's\"*. Pack day should be a checklist run, not a scavenger hunt. And keep **Cost** and **Link** current: cost rolls into the event budget, and the link is how the next event re-orders without the archaeology.",
      },
      {
        kind: "p",
        text: "This tab also carries the **site map**: a drawing of the venue — stage, stations, tables, flow of arrival — with supplies and crew placed on it. Walk the site before the event and map it; the map is the spatial view of everything the grid tracks.",
      },
    ],
    quiz: [
      {
        prompt: "What's the terminal STATUS for a supply item?",
        options: [
          "Packed",
          "Have it — status tracks acquisition; packing is tracked on the Packing checklist",
          "Ordered",
          "Pull from storage",
        ],
        answerIndex: 1,
        explanation:
          "Status walks an item to in-hand and stops at Have it. Packed-or-not lives in exactly one place — the Packing checklist — so a status can never claim what the trunk contradicts.",
      },
      {
        prompt: "You just picked up the borrowed speaker and marked it Have it. What else does the row need?",
        options: [
          "Nothing — Have it says it all",
          "Update Source/notes with where it lives now, so whoever packs knows where to grab it",
          "A new task on the Tasks tab",
          "Set its status back to Ordered for the record",
        ],
        answerIndex: 1,
        explanation:
          "Have it answers \"do we have it?\" — Source answers \"WHERE is it?\" The packer may not be the person who fetched it, so the row carries the location.",
      },
      {
        prompt: "Which ring does each half of a supply row feed?",
        options: [
          "Everything supplies feeds Day-of",
          "Getting it (order/buy) feeds Planning; packing it feeds Day-of",
          "Both feed Planning until the event starts",
          "Supplies don't affect the rings",
        ],
        answerIndex: 1,
        explanation:
          "Buying and ordering are prep on a real-world clock — Planning. Packing is what makes the day run — Day-of, even if you pack early. That's why the Timing column matters: orders have lead times.",
      },
      {
        prompt: "Why does the battery row deserve special paranoia?",
        options: [
          "Batteries are expensive",
          "It must leave storage early enough to charge at home — there's no charger in storage",
          "It's the heaviest item",
          "The venue provides batteries anyway",
        ],
        answerIndex: 1,
        explanation:
          "A battery pulled from storage the night before arrives flat. This exact failure is why the original checklist marked it VERY IMPORTANT.",
      },
      {
        prompt: "What is the site map?",
        options: [
          "A photo of the venue from Google Maps",
          "The venue layout drawing — stage, stations, arrival flow — with supplies and crew placed on it",
          "A list of driving directions",
          "The run of show in graphical form",
        ],
        answerIndex: 1,
        explanation:
          "The site map lives with Supplies & Logistics because it's the spatial view of the same area: everything the grid tracks, placed where it goes.",
      },
    ],
  },

  // ── 12 · Permits ───────────────────────────────────────────────────────────
  {
    slug: "tab-permits",
    title: "Permits",
    subtitle: "Paperwork on someone else's clock",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Public worship happens in public space — which means park permits, amplified-sound permits, sometimes food permits. Each permit is a row: jurisdiction contact, deadline, status, and the document attached once granted. Default owner: the Event Lead.",
      },
      {
        kind: "p",
        text: "**When to use it:** any event in a space you don't control. Backyard hangout? Toggle the tab off — not every event needs every tab. Public park with a speaker? Start at kickoff.",
      },
      {
        kind: "try_status",
        title: "Park permit — Maria Hernandez Park",
        options: [
          { value: "to_apply", label: "To apply", color: "red" },
          { value: "submitted", label: "Submitted", color: "amber" },
          { value: "approved", label: "Approved", color: "green" },
        ],
        terminal: "approved",
        caption:
          "Approved is the only terminal state — 'submitted' is the government thinking about it.",
      },
      {
        kind: "rule",
        title: "Approval is never in your hands",
        text: "Permits are the clearest case of a real-world lead time: park permits take 3+ weeks, sound permits ~3 days via the local precinct (and the permit holder must attend), food permits need proof of insurance. Apply at kickoff, and write every permit's \"what if denied\" line before you need it.",
      },
      {
        kind: "table",
        headers: ["Permit", "Lead time", "Learned the hard way"],
        rows: [
          ["Park / venue", "3+ weeks", "Eden applied in time and still got denied — the fallback saved the event"],
          ["Amplified sound", "~3 days", "Via the local precinct; the permit holder must be on site"],
          ["Food", "Weeks, often blocked", "Requires proof of insurance — know your contact before you need one"],
        ],
      },
    ],
    quiz: [
      {
        prompt: "When do permit applications start?",
        options: [
          "The week of the event",
          "At kickoff — they start now and resolve later",
          "After the announcement goes out",
          "Whenever the venue asks",
        ],
        answerIndex: 1,
        explanation:
          "Approval is on someone else's clock and never guaranteed. Starting at kickoff buys the slack that saved Eden when its permit was denied.",
      },
      {
        prompt: "Your event is in a friend's backyard. What happens to the Permits tab?",
        options: [
          "Fill it with 'not needed' rows",
          "Toggle it off — not every event needs every tab",
          "Delete the template",
          "Leave it empty forever",
        ],
        answerIndex: 1,
        explanation:
          "Tabs are toggleable per event and per template. An event only carries the areas it actually uses.",
      },
      {
        prompt: "Every permit row should carry a \"what if denied\" line. Why?",
        options: [
          "The city requires it",
          "Because approval is never in your hands — the fallback is written while you're calm, not improvised at T-2",
          "It speeds up the application",
          "It's needed for the budget",
        ],
        answerIndex: 1,
        explanation:
          "Hoping is not a mitigation. A written fallback (different spot, no amplification, adjusted food plan) is what makes a denial survivable.",
      },
    ],
  },

  // ── 13 · Debrief ───────────────────────────────────────────────────────────
  {
    slug: "tab-debrief",
    title: "Debrief",
    subtitle: "How the next event gets easier",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "After the event, while memories are fresh (our templates say within a week), the team captures four things: what went well, what broke, what was missing, what was excess. Each is a row on the Debrief tab. Default owner: the Event Lead.",
      },
      {
        kind: "p",
        text: "Every row then gets **dispatched** — one of three fates: *promoted* into the template, kept as *context* for future teams, or *dropped* on purpose. A row that just sits there is a lesson nobody learns.",
      },
      {
        kind: "try_status",
        title: "We needed trash bags",
        options: [
          { value: "open", label: "Open", color: "amber" },
          { value: "actioned", label: "Actioned", color: "green" },
        ],
        terminal: "actioned",
        caption:
          "Actioned = dispatched: promoted to the template, logged as context, or consciously dropped. This exact row became a template supplies row at Eden.",
      },
      {
        kind: "rule",
        title: "The debrief is finished when the template is better",
        text: "Not when the notes are written. Eden's debrief produced a dozen template improvements — earlier call times, more blankets, fewer plates, a circular stage layout. It's the most-skipped, highest-value hour in the whole lifecycle. Protect it.",
      },
      {
        kind: "p",
        text: "Concrete beats vague: \"more blankets, fewer plates\" with counts and costs becomes a template row; \"food was kinda off\" becomes nothing.",
      },
    ],
    quiz: [
      {
        prompt: "What are the three fates of a debrief row?",
        options: [
          "Approved, rejected, pending",
          "Promoted to the template, kept as context, or dropped on purpose",
          "Archived, deleted, or emailed",
          "Assigned, unassigned, escalated",
        ],
        answerIndex: 1,
        explanation:
          "Every learning gets dispatched. 'Actioned' with no artifact isn't a state — the row either changes the template, informs the future, or is consciously let go.",
      },
      {
        prompt: "When is the debrief actually done?",
        options: [
          "When the meeting ends",
          "When all rows are written down",
          "When the template is better — every row dispatched",
          "When the event is marked completed",
        ],
        answerIndex: 2,
        explanation:
          "The debrief is a template-editing session, not a feelings meeting. It's finished when the learnings are in the template, not on a page.",
      },
      {
        prompt: "Which debrief row is actually useful?",
        options: [
          "\"Food was kinda off\"",
          "\"Vibes were good\"",
          "\"8 pizzas fed everyone; we threw out 3 — order 6 next time\"",
          "\"Someone should look into the sound situation\"",
        ],
        answerIndex: 2,
        explanation:
          "Concrete, counted, costed rows become template changes. Vague rows become nothing. (The pizza math is a real Eden learning.)",
      },
    ],
  },

  // ── 14 · The assistant ─────────────────────────────────────────────────────
  {
    // Renamed from the v1 slug "working-with-the-assistant" ON PURPOSE: this
    // section gates the first capstone, and a surviving slug would let a
    // pre-redesign pass unlock the capstones past the ten new sections.
    slug: "using-the-assistant",
    title: "Working with the assistant",
    subtitle: "Briefings, batch edits, and what needs your consent",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every event page has an assistant that knows the playbook, the guides, and your live plan — statuses, due dates, owners, readiness. Open any event and ask it to brief you; it reads the real rows and leads with what matters *now*.",
      },
      {
        kind: "agent_demo",
        exchanges: [
          { who: "you", text: "Brief me on this event." },
          {
            who: "agent",
            text: "We're at T-9, readiness 62%. The headline: 3 crew spots are still unconfirmed and your template locks crew at T-10 — that's today's fix.",
          },
          {
            who: "agent",
            text: "Also: the sound permit row has no owner, and the run of show isn't locked (due T-3). Want me to assign owners to every unassigned task from its role?",
          },
          { who: "you", text: "Yes — and draft the crew ask for the group chat." },
          {
            who: "agent",
            text: "Done: 6 tasks assigned, one revertible run. The crew ask is drafted — it's public-facing, so nothing sends until you say so.",
          },
        ],
      },
      {
        kind: "p",
        text: "It works in **batches**: describes the changes, applies them in one revertible run, summarizes what changed. A wrong batch can be undone as a unit — which is why you can let it work freely on plan internals without babysitting every edit.",
      },
      {
        kind: "table",
        headers: ["It wants to…", "Who decides"],
        rows: [
          ["Edit rows, statuses, offsets, owners", "**Free hand** — revertible plan internals"],
          ["Delete anything, or mark anything *ready*", "**Asks first**"],
          ["Change the event date or status", "**Asks first**"],
          ["Anything crew- or public-facing (messages, blasts, pages)", "**Asks first**"],
        ],
      },
      {
        kind: "rule",
        title: "The consent line",
        text: "The plan is yours to iterate together; anything that reaches other humans — or signs your name to a claim — waits for a human's yes.",
      },
      {
        kind: "bullets",
        items: [
          '*"Brief me on my area — what\'s due, what\'s at risk, what\'s unowned?"*',
          '*"We\'re moving to June 14 — reschedule and tell me what becomes infeasible."*',
          '*"Is this event actually ready? Check it against the readiness criteria."*',
          '*"Run my debrief — interview me and draft the rows."*',
        ],
      },
    ],
    quiz: [
      {
        prompt: "Which of these will the assistant do WITHOUT asking first?",
        options: [
          "Send the reminder blast to crew",
          "Mark Supplies & Logistics ready",
          "Update statuses, offsets, and owners in one revertible batch",
          "Delete the stale comms rows",
        ],
        answerIndex: 2,
        explanation:
          "Plan internals are free-hand because every batch is revertible. Deleting, marking ready, date changes, and anything human-facing wait for your yes.",
      },
      {
        prompt: "Why does the assistant apply edits in batches?",
        options: [
          "Batches are cheaper to compute",
          "One proposal → one revertible run → one summary; a wrong batch undoes as a unit",
          "It can only write once per conversation",
          "To hide what it changed",
        ],
        answerIndex: 1,
        explanation:
          "Propose, apply, verify, stay reversible — that's what makes giving it a free hand on plan internals safe.",
      },
      {
        prompt: "Every row is Done, but the assistant won't mark the area ready itself. Why?",
        options: [
          "It can't see the ready flag",
          "Marking ready is a human signing their name to a claim — it will tell you the criteria are met, but the signature is yours",
          "Ready flags are admin-only",
          "It waits until T-1 to evaluate",
        ],
        answerIndex: 1,
        explanation:
          "Readiness is a claim someone puts their name on. The assistant checks the criteria; the human makes the claim.",
      },
    ],
  },

  // ── 15 · Capstone: join an event ───────────────────────────────────────────
  {
    slug: "capstone-join-an-event",
    title: "Capstone: join an event",
    subtitle: "Step into a big gathering as its Comms Lead",
    minutes: 8,
    capstone: { kind: "join_event" },
    blocks: [
      {
        kind: "p",
        text: "This is how most people actually meet Chapter OS: someone else created a big event from a template, and you got handed a role. **Start training** spins up that exact situation — a large worship gathering a month out (big events plan on long horizons), mid-planning, dozens of real rows across every tab — visible only to you. Your role: **Comms Lead**.",
      },
      {
        kind: "rule",
        title: "Nothing here is a mock-up",
        text: "The sandbox is the real product behind a training flag — real tabs, real status chips, the real assistant. It never appears in the chapter's Events tab, dashboards, or reminder emails. Everything you do here transfers one-to-one.",
      },
      { kind: "heading", text: "Your quests" },
      {
        kind: "p",
        text: 'Quests are rows in the event itself, prefixed **"Quest:"** — the checklist below ticks as each row reaches its terminal status. Each quest drills a move every area owner makes on every real event:',
      },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Take the Comms Lead role**", "Roles before people — put yourself in the hat"],
          ["**Find your work in Me view**", "Filter the whole event down to what's yours"],
          ["**Send the announcement**", "Walk a comms row to its terminal state"],
          ["**Post the crew ask**", "Check Crew Duties is written first — areas gate each other"],
          ["**Send the day-before call-time reminder**", "Your message quotes the Run of Show — areas depend on each other"],
          ["**Swap the Greeter placeholder for a person**", "Placeholders are debts — fill the slot from your sample bench"],
          ["**Ask the assistant to brief you on your area**", "Meet your chief of staff"],
          ["**Mark the Comms Schedule ready**", "Sign your name to an area, honestly"],
        ],
      },
      {
        kind: "p",
        text: "Two more things live in the sandbox: the Crew list has a couple of **role-shaped placeholder slots** (\"Greeter\") waiting to be filled, and your bench for filling them is **Maya and Jordan** — sample people. Person pickers inside a sandbox only ever offer *you and sample people*, so there's no way to accidentally rope a real teammate into a drill.",
      },
      {
        kind: "tip",
        text: "The assistant inside the event knows it's a training run — ask it for help on any quest.",
      },
    ],
    quiz: [],
  },

  // ── 16 · Capstone: plan a party ────────────────────────────────────────────
  {
    slug: "capstone-birthday-party",
    title: "Capstone: plan a party from scratch",
    subtitle: "A birthday, an empty plan, two teammates, and a clown",
    minutes: 10,
    capstone: { kind: "birthday_party" },
    blocks: [
      {
        kind: "p",
        text: "Now the other direction: nothing is planned yet. **Start training** creates a nearly-empty birthday party sandbox. You're the event owner. On your team: **Maya and Jordan**, two sample teammates who've been through this same training — put them in roles and hand them real areas of the plan. On your crew: **Uncle Ray** has agreed to run the grill and **Cousin Lena** is on decorations — and you still need to hire **Sunny the Clown** (yes, a paid professional; every party has a budget line that raises an eyebrow).",
      },
      {
        kind: "rule",
        title: "Same machine, any event",
        text: "A birthday party uses the exact same machinery as a worship gathering for two hundred people: tabs, rows, offsets, crew, readiness. If you can plan this party so it would run without you standing in the backyard, you can plan anything.",
      },
      { kind: "heading", text: "Your quests" },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Rename the party + set the date**", "Own the calendar — watch due dates derive"],
          ["**Add three tasks of your own, with timing**", "Build a plan backwards from the date"],
          ["**Give Maya and Jordan each a role**", "Delegation is the job — hand off whole areas"],
          ["**Hire Sunny the Clown as paid crew**", "Paid crew: amount, payment status, budget rollup"],
          ["**Send the invites**", "A comms row from draft to sent"],
          ["**Get the cake in hand**", "Walk a supply to Have it — and record where it lives"],
          ["**Ask the assistant to poke holes in your plan**", "Use the readiness check before you trust the plan"],
          ["**Log one learning and mark it Actioned**", "Close the loop — the debrief habit"],
        ],
      },
      {
        kind: "tip",
        text: "Uncle Ray and Cousin Lena are already on the Crew list as samples — check how their team, status, and call time are set up before you add Sunny.",
      },
    ],
    quiz: [],
  },

  // ── 17 · Bonus capstone: worship event ─────────────────────────────────────
  {
    slug: "capstone-worship-event",
    title: "Bonus: plan a worship event",
    subtitle: "Optional — the real thing, from scratch",
    minutes: 12,
    capstone: { kind: "worship_event" },
    optional: true,
    blocks: [
      {
        kind: "p",
        text: "Optional, and the best dress rehearsal there is: plan a pop-up worship event from scratch — the kind our chapters actually run. Public space, amplified sound, a worship leader to confirm, a battery that had better be charged. Everything you've drilled, in the domain you'll use it.",
      },
      {
        kind: "rule",
        title: "This is the event you'll actually run",
        text: "Finish this and your first real Worship With Strangers is a repeat, not a first attempt. It doesn't count toward your trained badge — it counts toward your first Saturday going smoothly.",
      },
      { kind: "heading", text: "Your quests" },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Set your date + location**", "The skeleton: a date and a place"],
          ["**Scout the spot + write the rain plan**", "Contingencies are structure, not vibes"],
          ["**Confirm a worship leader**", "The one person the program hangs on"],
          ["**Sort the sound permit**", "Lead-time work on someone else's clock"],
          ["**Build the run of show**", "Load-in → sound check → huddle → worship → strike, one owner each"],
          ["**Announce it**", "The comms moment — gated on your location being locked"],
          ["**Get the battery out, charged**", "Charged, in hand, on the Packing checklist — the T-1 ritual"],
          ["**Ask the assistant for a readiness briefing**", "The pre-flight check"],
          ["**Capture one learning and dispatch it**", "Feed the template — the loop that makes next time easier"],
        ],
      },
      {
        kind: "tip",
        text: "This one is yours to keep as a reference: when you plan your first real event, open this sandbox next to it and copy your own moves.",
      },
    ],
    quiz: [],
  },

  // ── 18 · Capstone: run the comms (Comms Lead) ──────────────────────────────
  {
    slug: "capstone-comms-lead",
    title: "Capstone: run the comms",
    subtitle: "Duties first, then recruit — build a crew from a real bench",
    minutes: 12,
    capstone: { kind: "comms_lead" },
    blocks: [
      {
        kind: "p",
        text: "You've read the Comms Lead's two tabs. Now do the job. **Start training** spins up a worship gathering three weeks out where the comms area is *yours from zero*: no duties written, open crew slots, and an announcement that hasn't gone anywhere. This is the exact situation a real Comms Lead walks into.",
      },
      {
        kind: "rule",
        title: "Duties before people, messages on a schedule",
        text: "The whole remit in one line: write what each team does BEFORE you recruit anyone into it, then make sure every audience hears from you in every phase. The quests walk that arc in order — the same order you'll use on a real event.",
      },
      { kind: "heading", text: "Your quests" },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Take the Comms Lead role**", "Put yourself in the hat — the tab's unowned rows become yours"],
          ["**Write the Welcome team's duties**", "The job description someone says yes to — written first"],
          ["**Write duties for Prayer and Content**", "Every team someone will join has its expectations in writing"],
          ["**Post the crew ask**", "Now you can recruit — against real, written jobs"],
          ["**Fill every open crew slot from your bench**", "Reach out and invite people in — placeholders become named humans"],
          ["**Chase every invite to Confirmed, with call times**", "Invited is a maybe; confirmed people with call times run events"],
          ["**Send the announcement**", "The public moment — gated on the venue being locked"],
          ["**Send the T-1 call-time reminder**", "Your copy quotes the Run of Show — areas depend on each other"],
          ["**Mark the Comms Schedule ready**", "Sign your name to the area, honestly"],
        ],
      },
      {
        kind: "p",
        text: "Your recruiting bench is the sandbox's **sample people** — Maya, Jordan, Sam, and Priya are on the roster waiting to be asked. Person pickers inside a sandbox only ever offer you and sample people, so practice the outreach moves freely: in real life this is the text you send a friend; here, filling the slot IS the simulated yes.",
      },
      {
        kind: "tip",
        text: "Stuck on copy? Ask the event's assistant to draft the crew ask or the reminder — reviewing and sending its draft is exactly how the job works outside the sandbox too.",
      },
    ],
    quiz: [],
  },

  // ── 19 · Capstone: run the plan (Event Lead) ───────────────────────────────
  {
    slug: "capstone-event-lead",
    title: "Capstone: run the plan",
    subtitle: "Overdue rows, missing tasks, a permit, and the owner's test",
    minutes: 12,
    capstone: { kind: "event_lead" },
    blocks: [
      {
        kind: "p",
        text: "The Event Lead's job isn't doing every row — it's making sure the *whole plan* happens. **Start training** hands you a worship gathering three weeks out that's drifting: something's overdue, something's missing, the run of show is a stub, and a permit is sitting unapplied-for. Exactly the mid-flight mess a real Event Lead inherits.",
      },
      {
        kind: "rule",
        title: "The red band is where your problems live",
        text: "An Event Lead reads the plan top-down every day: overdue first, unowned second, missing third. Fix the plan, not the moment — every gap you close here is a fire that never starts.",
      },
      { kind: "heading", text: "Your quests" },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Take the Event Lead role**", "The chain now ends at you — unowned rows are yours"],
          ["**Clear the overdue venue walkthrough**", "Triage the red band first, every time"],
          ["**Add the missing task, written for a stranger**", "Details carry the how and the why past the person who knew"],
          ["**Give Maya and Jordan each an area**", "Delegation is the job — hand off whole slices, not errands"],
          ["**Build the run of show, one named owner per segment**", "Day-of needs zero improvisation about who"],
          ["**Walk the sound permit to Approved**", "Lead-time work on someone else's clock"],
          ["**Write the rain plan + permit fallback**", "Contingencies are structure, written while you're calm"],
          ["**Ask the assistant for the owner's test**", '"If I disappeared today, what breaks?"'],
          ["**Log one learning and dispatch it**", "The debrief habit — close the loop you'll rely on later"],
        ],
      },
      {
        kind: "p",
        text: "Maya and Jordan are sample teammates on your roster — put them in the Comms and Logistics hats and let the plan resolve work to them. The test at the end is the one that matters: read the plan as if you won't be there, and make every wobble a row.",
      },
      {
        kind: "tip",
        text: "The rings on the event header are your dashboard for this whole capstone — watch the Planning ring's pace check flip from amber to \"✓ on pace\" as you clear the overdue rows.",
      },
    ],
    quiz: [],
  },

  // ── 20 · Capstone: run the supplies (Logistics Lead) ───────────────────────
  {
    slug: "capstone-logistics-lead",
    title: "Capstone: run the supplies",
    subtitle: "Get it, know where it lives, pack it — for real",
    minutes: 10,
    capstone: { kind: "logistics_lead" },
    blocks: [
      {
        kind: "p",
        text: "Every physical thing the event needs, in hand, in a known container, on time. **Start training** creates a worship gathering two weeks out whose supply list has every classic problem: an order that needs to go out *now*, a battery in storage with no charger, ice nobody's bought, and gaps in the list itself.",
      },
      {
        kind: "rule",
        title: "Every item is two jobs on two clocks",
        text: "Getting it is planning work with real-world lead times; packing it is the day-of ritual tracked on the Packing checklist. The quests make you work both clocks — and record WHERE things live, so pack day is a checklist run, not a scavenger hunt.",
      },
      { kind: "heading", text: "Your quests" },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Take the Logistics Lead role**", "Unowned items default to you — own the tab"],
          ["**Order the connect cards before shipping closes**", "Order-online rows carry a lead time — walk it to Have it"],
          ["**Get the battery out, charged**", "The VERY IMPORTANT row: no charger in storage"],
          ["**Buy the ice + record where it lives**", "Have it answers 'do we?'; Source answers 'where?'"],
          ["**Add two missing items with have-it-by timing**", "The list is yours to complete, not just execute"],
          ["**Run the packing checklist**", "Packed is a checklist, never a status"],
          ["**Draw the site map**", "The spatial view — supplies and crew placed where they go"],
          ["**Mark Supplies & Logistics ready**", "Sign your name: everything in hand, packed, and placed"],
        ],
      },
      {
        kind: "tip",
        text: "The two-clock rule shows up in the rings: watch acquisitions move the Planning ring while packing moves Day-of — same rows, two jobs.",
      },
    ],
    quiz: [],
  },

  // ── 21 · Works: what a project is ──────────────────────────────────────────
  {
    slug: "works-projects",
    title: "Projects",
    subtitle: "Finite work with one owner and a finish line",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Not everything the chapter does is an event. Redesign the welcome cards, stand up the giving page, find a winter venue — that's a **project**: a unit of work the team is driving, beyond (or wrapping) events. Projects live on the **Work** tab, next to Duties.",
      },
      {
        kind: "table",
        headers: ["A project carries", "Why it's there"],
        rows: [
          ["**Purpose**", "What done looks like, so scope arguments end early"],
          ["**One owner**", "The single human accountable for the outcome"],
          ["**Status**", "Not started → In progress → **Blocked** → Done"],
          ["**Deadline**", "A project without a date is a wish"],
          ["**Blocker**", "When it's stuck: what's stuck, in writing, where the manager can see it"],
        ],
      },
      {
        kind: "try_status",
        title: "Find a winter venue",
        options: [
          { value: "not_started", label: "Not started", color: "gray" },
          { value: "in_progress", label: "In progress", color: "amber" },
          { value: "blocked", label: "Blocked", color: "red" },
          { value: "done", label: "Done", color: "green" },
        ],
        terminal: "done",
        caption:
          "Blocked is a loud state on purpose — it's a hand up, not a confession. A project quietly stuck at In progress is the one that dies.",
      },
      {
        kind: "rule",
        title: "Legible without a meeting",
        text: "Projects exist so anyone — especially your manager — can see the state of everything in flight without booking a call: status, deadline, blocker, next step. If reading the project answers those, you're doing it right.",
      },
      {
        kind: "p",
        text: "Big project? Split it into **sub-projects**, each with its own owner and deadline, rolling up to the parent. And a project that's really an event's prep belongs *in the event* — projects wrap events, they don't duplicate them.",
      },
      {
        kind: "reveal",
        prompt:
          'Someone says "I\'m working on the merch thing." Where should that sentence live?',
        answer:
          "As a project: name it, give it a purpose line, an owner (them), a status, and a deadline. \"Working on a thing\" is a vibe; a project row is a commitment someone can see, help with, and hold to.",
      },
    ],
    quiz: [
      {
        prompt: "What makes something a project rather than an event or a task?",
        options: [
          "It costs money",
          "It's finite team work with an owner and a finish line, driven outside (or wrapping) an event",
          "It takes more than a week",
          "Only admins can create projects",
        ],
        answerIndex: 1,
        explanation:
          "Projects are the chapter's finite non-event work: they finish. Recurring work is a duty; dated gatherings are events; single to-dos inside an event are that event's rows.",
      },
      {
        prompt: "Why is Blocked its own status instead of a note somewhere?",
        options: [
          "To punish the owner",
          "Because a blocked project needs to be LOUD — the blocker is written where the manager can see it and act without a meeting",
          "Because the app can't store notes",
          "Blocked projects are deleted after a week",
        ],
        answerIndex: 1,
        explanation:
          "Blocked is a hand up. The quiet failure mode is a project sitting at In progress while nothing moves — naming the blocker in the open is how it gets cleared.",
      },
      {
        prompt: "What's wrong with a project that has no deadline?",
        options: [
          "Nothing — some work is open-ended",
          "It can't have sub-projects",
          "A project without a date is a wish: nothing surfaces it, nothing makes it urgent, and it will lose to everything that has one",
          "The app rejects it",
        ],
        answerIndex: 2,
        explanation:
          "Finite work needs a finish line. If the work genuinely never finishes, it isn't a project — it's a duty, which is built for exactly that.",
      },
      {
        prompt: "Your manager wants to know how the giving-page project is going. What should already be true?",
        options: [
          "You have a meeting scheduled to walk them through it",
          "The project row already answers it: current status, deadline, blocker if stuck — legible without a meeting",
          "They should ask the assistant to email you",
          "Projects are private to their owner",
        ],
        answerIndex: 1,
        explanation:
          "The whole point: a manager can see the state of everything their team is driving without meeting the owner. Keeping the row true IS the report.",
      },
    ],
  },

  // ── 22 · Works: driving a project ───────────────────────────────────────────
  {
    slug: "works-driving-a-project",
    title: "Driving a project to done",
    subtitle: "The progression log, blockers, and escalating early",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Owning a project is a rhythm, not a status: move it, log it, flag what's stuck. The project's **comment thread is the progression record** — each update says what moved and what's next, so the history reads like a story anyone can pick up.",
      },
      {
        kind: "bullets",
        items: [
          "**Update on motion, not on schedule.** When something real happens — a decision, a delivery, a dead end — it goes in the thread that day.",
          '**Write for the next owner.** "Called the print shop, 3-day turnaround, files due Friday" survives you; "made progress" doesn\'t.',
          "**Blocked means saying WHO unblocks it.** A blocker without a name attached is a complaint, not an escalation.",
        ],
      },
      {
        kind: "rule",
        title: "Escalate early",
        text: "Blocked early is a conversation; blocked at the deadline is a crisis. The moment you know you're stuck — or that the date will slip — the status flips, the blocker gets written, and your manager finds out from the app, not from the deadline passing.",
      },
      {
        kind: "p",
        text: "The app meets you where you are: project reminder emails carry **action links** — mark it done or flag it blocked straight from the email, no login required. There is no excuse for a stale project status.",
      },
      {
        kind: "reveal",
        prompt:
          "Your project's deadline is Friday and the vendor just went quiet. It's Tuesday. What do you do?",
        answer:
          "Flip it to Blocked today, name the blocker (\"vendor unresponsive since Mon — need a decision: wait or switch\"), and put what you need in the thread. Tuesday-you created options; Friday-you would have delivered an apology.",
      },
      {
        kind: "tip",
        text: "Finished? Mark it Done and write the last comment as a handoff: what shipped, where it lives, anything the next person needs. Done with no trail is done only for you.",
      },
    ],
    quiz: [
      {
        prompt: "What is the project comment thread for?",
        options: [
          "Congratulating the owner",
          "It's the progression record — what moved, what's next, written so anyone could pick the project up",
          "Legal compliance",
          "It's where the deadline is stored",
        ],
        answerIndex: 1,
        explanation:
          "The thread IS the project's story. Updates written for the next owner make the work legible, handoffable, and reviewable without a meeting.",
      },
      {
        prompt: "You realize on Tuesday the Friday deadline will slip. What's the right move?",
        options: [
          "Work harder and hope",
          "Wait until Friday to be sure, then explain",
          "Flip to Blocked / flag the slip now, name what's stuck and who can unblock it",
          "Quietly move the deadline",
        ],
        answerIndex: 2,
        explanation:
          "Escalate early: blocked early is a conversation, blocked at the deadline is a crisis. Early warnings create options — wait, switch, re-scope — that vanish at the deadline.",
      },
      {
        prompt: "What makes a blocker entry useful?",
        options: [
          "It's long and detailed about how frustrating things are",
          "It names what's stuck AND who or what unblocks it",
          "It's marked urgent",
          "It tags the whole team",
        ],
        answerIndex: 1,
        explanation:
          "A blocker without a name attached is a complaint. \"Waiting on venue contract — need Jordan's signature\" is an escalation someone can act on.",
      },
    ],
  },

  // ── 23 · Works: duties ──────────────────────────────────────────────────────
  {
    slug: "works-duties",
    title: "Duties",
    subtitle: "The work that never finishes — on a cadence, on a role",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Some work has no finish line: create the event flyers, meet with your directs, reconcile giving. That's a **duty** — ongoing, recurring org work. Projects finish; duties *recur*. They're siblings on the Work tab, split by exactly that difference.",
      },
      {
        kind: "table",
        headers: ["A duty carries", "What it means"],
        rows: [
          ["**Cadence**", "Daily, weekly, biweekly, monthly, quarterly, yearly — or ad hoc"],
          ["**Who it fans out to**", "Roles (\"every Director\"), specific people, or both"],
          ["**A runbook**", "The how-to doc: how this duty is actually done"],
        ],
      },
      {
        kind: "p",
        text: "The fan-out is the clever part: assign a duty to a **role** and it lands on everyone holding that role — \"Meet with directs, weekly\" hits every manager automatically, including ones who join next year. Assign to a person only when the duty is genuinely theirs alone.",
      },
      {
        kind: "rule",
        title: "If it recurs, it's a duty — not a memory",
        text: "Recurring work kept in someone's head gets done exactly as long as that person remembers, cares, and stays. Written as a duty with a cadence, it survives vacations, handoffs, and growth.",
      },
      {
        kind: "reveal",
        prompt:
          '"Every month someone should check the storage unit and restock." Project, duty, or task?',
        answer:
          "A duty: it recurs (monthly cadence) and it's role-shaped work, not a one-off. Write it, set the cadence, point it at the Logistics role — and it outlives whoever thought of it.",
      },
    ],
    quiz: [
      {
        prompt: "What's the fundamental difference between a project and a duty?",
        options: [
          "Projects are bigger",
          "Projects finish; duties recur on a cadence",
          "Duties are optional",
          "Only leads can own duties",
        ],
        answerIndex: 1,
        explanation:
          "Finite vs. recurring is the whole split. A finish line makes it a project; a cadence makes it a duty.",
      },
      {
        prompt: 'A duty is assigned to the "Director" role. A new director joins next month. What happens?',
        options: [
          "Someone must remember to assign them the duty",
          "The duty automatically applies to them — role fan-out lands on everyone holding the role",
          "The duty resets its cadence",
          "New people can't hold duties for 90 days",
        ],
        answerIndex: 1,
        explanation:
          "That's why duties fan out to roles: the work follows the hat. Assign to a specific person only when the duty is genuinely theirs alone.",
      },
      {
        prompt: "Why does cadence matter on a duty?",
        options: [
          "It sets how often the duty appears in reviews and reminders — a quarterly duty shouldn't nag weekly, and a weekly one shouldn't hide for a month",
          "It changes who owns the duty",
          "It's just a label",
          "Cadence controls the budget",
        ],
        answerIndex: 0,
        explanation:
          "The cadence drives when the duty is due for attention — in reminders and in 1:1 reviews — so recurring work surfaces at its own rhythm instead of all the time or never.",
      },
    ],
  },

  // ── 24 · Works: owning a duty ───────────────────────────────────────────────
  {
    slug: "works-owning-a-duty",
    title: "Owning a duty",
    subtitle: "Runbooks, keeping cadence, and handing off without a meeting",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Holding a duty means two promises: the work happens *on its cadence*, and the way it's done is *written down*. The second promise is the one people skip — and it's the one that makes the first survivable.",
      },
      {
        kind: "rule",
        title: "The runbook is the duty's real owner",
        text: "Every duty carries a how-to doc: the steps, the accounts, the gotchas. Written well, a handoff doesn't need a meeting — the next person reads the runbook and does the duty. If only you can do it, you don't own a duty; the duty owns you.",
      },
      {
        kind: "bullets",
        items: [
          "**Keep the runbook true.** The moment you find a better way, the doc changes — same reflex as fixing the template after a debrief.",
          "**Keep the cadence honestly.** Fulfilled means it actually happened this cycle — your 1:1 will ask, and the honest answer is the useful one.",
          "**Flag overload early.** If the duty no longer fits your plate, say so at the 1:1 — reducing or transferring a duty on purpose beats dropping it quietly.",
        ],
      },
      {
        kind: "p",
        text: "Duties are also how your manager helps you: at each 1:1 the duties due for review come up — going well? still the right amount of work? still the right person? A duty conversation is workload care wearing its work clothes.",
      },
      {
        kind: "reveal",
        prompt:
          "You're handing your flyer duty to a new volunteer. What does a good handoff look like?",
        answer:
          "Point them at the runbook — templates, brand assets, where files live, lead times — and update the duty's assignment. If they need a meeting to start, the runbook wasn't done. (A quick hello still helps; needing it shouldn't.)",
      },
    ],
    quiz: [
      {
        prompt: "What makes a duty handoff work without a meeting?",
        options: [
          "A long email",
          "The runbook — the duty's how-to doc carries the steps, accounts, and gotchas",
          "The new person's experience",
          "Handoffs always need meetings",
        ],
        answerIndex: 1,
        explanation:
          "The runbook is the institutional memory. Write it so the next person can do the duty cold — that's what makes the duty the chapter's, not yours.",
      },
      {
        prompt: "A duty stopped fitting your workload. What's the right move?",
        options: [
          "Keep it and let it quietly slip",
          "Raise it at your 1:1 so it's reduced or transferred on purpose",
          "Delete the duty",
          "Do it badly until someone notices",
        ],
        answerIndex: 1,
        explanation:
          "Dropping work quietly is how trust erodes. The 1:1 exists to rebalance load deliberately — a transferred duty with a runbook loses nothing.",
      },
      {
        prompt: "When should a duty's runbook change?",
        options: [
          "Once a year, at review time",
          "The moment you find a better way to do the duty",
          "Only when the owner changes",
          "Never — runbooks are frozen",
        ],
        answerIndex: 1,
        explanation:
          "Same reflex as template improvements after a debrief: learnings go in the written source immediately, so the next execution inherits them.",
      },
    ],
  },

  // ── 25 · Management: the 1:1 ────────────────────────────────────────────────
  {
    slug: "mgmt-one-on-one",
    title: "The 1:1: person first, then work",
    subtitle: "The conversation order, the two pulses, and who reads what",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The 1:1 is management's basic unit: a recurring conversation with each direct report, logged in the app as a **check-in**. The form walks the order the conversation should actually go — and the order is the philosophy.",
      },
      {
        kind: "table",
        headers: ["In order", "What you're asking"],
        rows: [
          ["**Did it happen?**", "A skipped 1:1 gets logged as skipped — silence isn't neutral, it's data"],
          ["**The person**", "Personal and prayer updates — how are they, before what have they done"],
          ["**The two pulses**", "Workload 1–10 (5–6 is right; 10 is drowning) and interest 1–10 (is this the right work?)"],
          ["**Their duties**", "Each duty due for review: being fulfilled? If not — choose a course of action"],
          ["**Their projects**", "On track or not, per project"],
          ["**Feedback**", "What went well, what to improve, and above-and-beyond moments worth naming up the chain"],
        ],
      },
      {
        kind: "rule",
        title: "Person first, then work",
        text: "You cannot hold someone accountable for work while ignoring the human doing it. The order is deliberate: care isn't the warm-up to the real conversation — it's the context that makes the work conversation true.",
      },
      {
        kind: "p",
        text: "The two pulses are trend instruments, not one-off scores. A workload sliding 6 → 8 → 9 across three check-ins is a burnout siren *before* the burnout; an interest score stuck at 3 says re-scope this person's work before they re-scope themselves out of the chapter.",
      },
      {
        kind: "p",
        text: "And the cadence does the filtering for you: a **quarterly** duty doesn't clutter every **weekly** 1:1 — each duty surfaces when it's actually due for a look.",
      },
      { kind: "heading", text: "Who reads a check-in" },
      {
        kind: "p",
        text: "Check-ins are read by the **chain above** — a manager, their manager, and up. A report never reads the managerial record about themselves, and you never log a check-in on yourself. That privacy is what makes the notes honest; honest notes are what make the care real.",
      },
      {
        kind: "reveal",
        prompt:
          "Your direct cancelled the last two 1:1s. Busy season — skip logging them?",
        answer:
          "Log them as skipped. Two skips is a pattern the chain above should see, and a conversation you should open: is the load too high, is the 1:1 badly timed, or are they avoiding something? The skip record is the start of care, not bureaucracy.",
      },
    ],
    quiz: [
      {
        prompt: "Why does the check-in ask about the person before the work?",
        options: [
          "Small talk warms up the meeting",
          "Because accountability without knowing how the human is doing isn't accountability — the personal context makes the work conversation true",
          "The work questions are optional",
          "It's alphabetical",
        ],
        answerIndex: 1,
        explanation:
          "Person first, then work — the form's order is the philosophy. Care is the context for accountability, not a preamble to it.",
      },
      {
        prompt: "What does a workload pulse of 9–10 mean?",
        options: [
          "They're a top performer",
          "Far too much on their plate — rebalance before it breaks them; 5–6 is the healthy zone",
          "They should be promoted",
          "Nothing without the interest score",
        ],
        answerIndex: 1,
        explanation:
          "The scale reads 1 = far too little, 10 = far too much, 5–6 ≈ right. High scores trending up are the burnout siren the 1:1 exists to catch early.",
      },
      {
        prompt: "Who can read the check-in you logged about your direct report?",
        options: [
          "Everyone in the chapter",
          "The report themselves, always",
          "The chain above — you and the managers over you; the report never reads the record about themselves",
          "Only admins",
        ],
        answerIndex: 2,
        explanation:
          "Chain-above visibility keeps the notes honest. It's a managerial record, not a shared doc — and you can't log one on yourself for the same reason.",
      },
      {
        prompt: "Why doesn't every duty come up at every 1:1?",
        options: [
          "Duties are reviewed yearly",
          "Review follows the duty's own cadence — a quarterly duty surfaces quarterly, so weekly 1:1s stay focused",
          "Managers pick favorites",
          "Duties never come up at 1:1s",
        ],
        answerIndex: 1,
        explanation:
          "Cadence-aware review keeps the conversation honest and short: each duty gets attention on its own rhythm, not as a recurring wall of checkboxes.",
      },
    ],
  },

  // ── 26 · Management: reviewing the work ─────────────────────────────────────
  {
    slug: "mgmt-reviewing-the-work",
    title: "Reviewing the work",
    subtitle: "Fulfilled or not, on track or not — and feedback that travels",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "After the person, the work — and the check-in makes it binary on purpose. Each duty due for review: **being fulfilled, yes or no?** Each project: **on track, yes or no?** Not \"how's it going\" — that question invites the answer \"fine\", and \"fine\" is where problems hide.",
      },
      {
        kind: "rule",
        title: "A 'no' is a decision point, not a verdict",
        text: "\"Not fulfilled\" doesn't end the conversation — it starts one: why, and what happens next? You'll pick an explicit course of action, and the smallest action that actually fixes the problem is the right one.",
      },
      {
        kind: "p",
        text: "Feedback closes the loop, in three registers: what went **well** (said out loud, every time), what to **improve** (specific, or skip it), and **above-and-beyond** moments — which get *named up the chain*, because the chain above reads the check-in. Praise that reaches your manager's manager is retention no thank-you card matches.",
      },
      {
        kind: "reveal",
        prompt:
          'Their project is "mostly on track — the vendor bit is a little behind." On track: yes or no?',
        answer:
          "No. \"Mostly on track\" is the polite spelling of \"behind at the vendor.\" Mark it off-track, get the blocker written on the project, and decide together what unsticks it. The binary exists to make exactly this call honest.",
      },
      {
        kind: "tip",
        text: "Before the 1:1, open their workload page — events, roles, duties, projects in one view. Two minutes of reading turns \"so, what are you up to?\" into \"let's talk about the two things that look stuck.\"",
      },
    ],
    quiz: [
      {
        prompt: "Why are the work questions binary (fulfilled / on track — yes or no)?",
        options: [
          "To make the form faster to fill in",
          "Because \"how's it going\" invites \"fine\", and \"fine\" is where problems hide — the binary forces the honest call",
          "Because managers can't handle nuance",
          "The database only stores booleans",
        ],
        answerIndex: 1,
        explanation:
          "The binary is a truth-forcing device. Nuance belongs in the conversation and the notes; the yes/no makes sure the conversation happens.",
      },
      {
        prompt: "What makes an above-and-beyond note different from saying thanks in the moment?",
        options: [
          "It's longer",
          "It travels: the chain above reads the check-in, so the praise reaches leadership with the person's name on it",
          "It comes with a bonus",
          "Nothing — it's the same thing",
        ],
        answerIndex: 1,
        explanation:
          "Naming great work up the chain is a retention strategy: people stay where their work is seen beyond their own manager.",
      },
      {
        prompt: "What should you do BEFORE a 1:1 to make it useful?",
        options: [
          "Nothing — spontaneity is best",
          "Read their workload page: events, roles, duties, projects — then open with the things that look stuck",
          "Prepare a lecture on accountability",
          "Reassign their duties as a surprise",
        ],
        answerIndex: 1,
        explanation:
          "The app gives you the whole picture without a status meeting — spend the 1:1 on the two things that matter, not on collecting a verbal status report.",
      },
    ],
  },

  // ── 27 · Management: caring for people ──────────────────────────────────────
  {
    slug: "mgmt-caring-for-people",
    title: "People are a renewable resource",
    subtitle: "— if you tend them. Load, rotation, and feeling thanked",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "A chapter runs on volunteers and leads who *come back*. They come back when the experience was organized, they knew what to do, and they felt thanked. They quit when they were **confused, idle, or overloaded** — three failures of management, not of commitment.",
      },
      {
        kind: "table",
        headers: ["They quit when…", "The tending that prevents it"],
        rows: [
          ["**Confused**", "Written duties, real runbooks, clear owners — nobody guesses what their job is"],
          ["**Idle**", "Right-sized assignments; an interest pulse that's actually read"],
          ["**Overloaded**", "Workload pulses watched as trends; load rebalanced before it breaks someone"],
        ],
      },
      {
        kind: "rule",
        title: "Rotation is structure, not sentiment",
        text: "Rotate people through roles before they burn out — and before the institution starts depending on one person. Rotation is simultaneously how you keep humans healthy and how the chapter stops being one resignation away from collapse.",
      },
      {
        kind: "p",
        text: "Gratitude is part of the system, not a personality trait: thank-you messages are planned comms rows, above-and-beyond moments get named up the chain, and completed work is visible on the person's record. Felt appreciation is engineered, and that's not cynical — it's reliable.",
      },
      {
        kind: "reveal",
        prompt:
          "Your best organizer has run comms for six events straight and keeps saying yes. Leave them in the seat?",
        answer:
          "No — that's the trap. Six straight yeses with a rising workload pulse is how your best person burns out AND how the chapter becomes unable to run comms without them. Rotate someone in beside them, have the runbooks written, and give your veteran a different challenge. Keeping them isn't kindness; it's deferred collapse.",
      },
    ],
    quiz: [
      {
        prompt: "What are the three conditions that make volunteers quit?",
        options: [
          "Low pay, long hours, bad weather",
          "Confused, idle, or overloaded",
          "Too much training, too many tools, too many meetings",
          "There's no pattern to it",
        ],
        answerIndex: 1,
        explanation:
          "All three are management failures with management fixes: written expectations cure confusion, right-sizing cures idleness, watched workload cures overload.",
      },
      {
        prompt: "Why is rotation about more than preventing burnout?",
        options: [
          "It isn't — burnout is the only reason",
          "Rotation also stops the institution from depending on one person — no role should be one resignation from collapse",
          "It keeps things fair on paper",
          "It reduces training costs",
        ],
        answerIndex: 1,
        explanation:
          "Rotation is redundancy for humans: healthy people AND a chapter that survives any single departure. The runbooks and templates are what make it cheap.",
      },
      {
        prompt: "\"Gratitude is engineered\" means…",
        options: [
          "Thank-yous are insincere",
          "Appreciation is built into the system — planned thank-you comms, above-and-beyond notes up the chain — so it happens reliably, not just when someone remembers",
          "Only the app is allowed to thank people",
          "Gratitude requires a budget line",
        ],
        answerIndex: 1,
        explanation:
          "Feeling thanked is one of the three reasons people come back. Anything that important gets a system, because memory and mood don't scale.",
      },
    ],
  },

  // ── 28 · Management: holding the line ───────────────────────────────────────
  {
    slug: "mgmt-holding-the-line",
    title: "Holding the line",
    subtitle: "Care without accountability is abandonment with a smile",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The other half of care: **the work has to happen.** Letting a duty quietly go unfulfilled isn't kindness — it dumps the load on whoever picks up the slack, teaches the team that commitments are optional, and robs the person of the honest feedback they'd need to grow. Caring managers hold the line *because* they care.",
      },
      {
        kind: "p",
        text: "When a duty comes up \"not fulfilled\" at a check-in, you pick an explicit course of action — a ladder, from lightest to heaviest:",
      },
      {
        kind: "table",
        headers: ["Action", "When it's right"],
        rows: [
          ["**Warning**", "First slip, capable person — name it, note it, move on"],
          ["**Reduce responsibilities**", "The load is the problem — shrink it to what they can carry"],
          ["**Transfer the responsibility**", "Wrong person-duty fit — move it, with its runbook"],
          ["**Manager took it over**", "Emergency stopgap ONLY — flag that the system failed and fix it"],
          ["**Reassigned**", "A different seat fits better than a smaller load"],
          ["**Remove from team**", "The pattern held through every lighter rung — end it honestly"],
        ],
      },
      {
        kind: "rule",
        title: "The smallest action that fixes it — chosen out loud",
        text: "Escalate the ladder one honest rung at a time, and SAY which rung you're on. \"Consider this a warning\" is respect; unspoken disappointment is a trap you set for someone you claim to care about.",
      },
      {
        kind: "p",
        text: "Watch the fourth rung. Taking the work over yourself feels noble and solves this week — but as a habit it teaches the plan to lie, trains the person to lean, and buries you. The same doctrine as event ownership: accountability flows *through* people, not around them.",
      },
      {
        kind: "reveal",
        prompt:
          "A sweet, chronically overloaded volunteer hasn't made flyers in two months. You keep covering it yourself. What's actually happening?",
        answer:
          "Three failures wearing a kindness costume: the volunteer is overloaded and nobody's fixing THAT (reduce or transfer!), the duty's record says fulfilled when it isn't, and you're now doing two jobs. The caring move is the honest one: name it at the 1:1, then reduce or transfer the duty — with its runbook — on purpose.",
      },
    ],
    quiz: [
      {
        prompt: "Why is quietly tolerating an unfulfilled duty NOT the caring move?",
        options: [
          "It is the caring move — pressure is harmful",
          "It dumps the load on others, teaches the team commitments are optional, and denies the person honest feedback",
          "Because the app sends automatic warnings anyway",
          "Because duties expire",
        ],
        answerIndex: 1,
        explanation:
          "Care without accountability abandons everyone involved — the team carrying the slack most of all. Holding the line IS the care.",
      },
      {
        prompt: "How do you choose an action when a duty isn't being fulfilled?",
        options: [
          "Always start with removal to show seriousness",
          "The smallest action that actually fixes the problem, stated out loud — warning, reduce, transfer, up the ladder as needed",
          "Never act — wait for them to self-correct",
          "Take the duty over yourself immediately",
        ],
        answerIndex: 1,
        explanation:
          "The ladder runs lightest to heaviest, one honest rung at a time — and the person always knows which rung they're on.",
      },
      {
        prompt: "Why is \"the manager took it over\" flagged as a warning sign rather than a solution?",
        options: [
          "Managers aren't allowed to do work",
          "As a habit it teaches the plan to lie, trains the person to lean, and buries the manager — it's an emergency stopgap that must trigger a real fix",
          "It's fine — it's the recommended default",
          "Because it looks bad in reports",
        ],
        answerIndex: 1,
        explanation:
          "Same doctrine as event ownership: don't silently do it yourself. Accountability flows through people; taking over is the rung you step on only while arranging a real one.",
      },
      {
        prompt: "What makes a warning respectful rather than harsh?",
        options: [
          "Softening it until it's not really a warning",
          "Saying it plainly and naming it as a warning — the person knows exactly where they stand",
          "Delivering it publicly for transparency",
          "Skipping it and going straight to reassignment",
        ],
        answerIndex: 1,
        explanation:
          "Unspoken disappointment is a trap. Clear is kind: a named warning gives the person a real chance to fix the pattern.",
      },
    ],
  },

  // ── 29 · Management: the org tree ───────────────────────────────────────────
  {
    slug: "mgmt-the-org-tree",
    title: "The manager tree",
    subtitle: "Your subtree is your reach — and your responsibility",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every person in the chapter has (at most) one manager, and the manager links form a tree. That tree isn't an org-chart decoration — it's the **authority model**: a manager may see and manage the workload of their *subtree* — themselves and everyone below them — and nothing beyond it.",
      },
      {
        kind: "bullets",
        items: [
          "**Your directs** are your 1:1s, your check-ins, your calls on the action ladder.",
          "**Your subtree** is your visibility: a director sees the whole structure under them, level by level.",
          "**Beyond your subtree** is genuinely out of reach — the server enforces it; the UI hiding things is just good manners.",
          "**Admins** stand outside the tree: they can see everything and rewire the tree itself.",
        ],
      },
      {
        kind: "rule",
        title: "Reach and responsibility are the same edge",
        text: "The subtree you can see is exactly the subtree you answer for. If someone's workload is drifting and they're under you — anywhere under you — the tree says whose job it is to notice: yours.",
      },
      {
        kind: "p",
        text: "The **workload view** is the tree made useful: pick anyone under you and see everything on their plate — events and roles, projects, duties, recent check-ins — without calling a status meeting. It's how a director stays honest about what the team is actually carrying.",
      },
      {
        kind: "reveal",
        prompt:
          "You manage Sam. Sam manages four event leads. One of them is visibly drowning. Whose problem is it?",
        answer:
          "Sam's first — the drowning lead is Sam's direct, and the 1:1 and rebalancing are Sam's to run. But it's also yours, because your subtree includes them both: if Sam isn't noticing, THAT's the gap your next 1:1 with Sam is about. Trees delegate action, never awareness.",
      },
    ],
    quiz: [
      {
        prompt: "What does the manager tree actually control?",
        options: [
          "Seating at chapter dinners",
          "Authority and visibility: you may see and manage the workload of your subtree, and nothing beyond it",
          "Only who gets CC'd on emails",
          "Nothing — it's decorative",
        ],
        answerIndex: 1,
        explanation:
          "The tree IS the authority model, enforced server-side. Your subtree is your reach; beyond it is genuinely out of bounds, not just hidden.",
      },
      {
        prompt: "A lead two levels below you is quietly overloaded and their manager hasn't noticed. What's true?",
        options: [
          "Not your problem — you only answer for directs",
          "It's in your subtree, so noticing is your job too — and the manager's miss is what your next 1:1 with THAT manager is about",
          "You should take over their duties yourself",
          "Only an admin can act",
        ],
        answerIndex: 1,
        explanation:
          "Reach and responsibility are the same edge. Action stays delegated (their manager runs the 1:1), but awareness never is.",
      },
      {
        prompt: "What is the workload view for?",
        options: [
          "Ranking people by output",
          "Seeing everything on one person's plate — events, projects, duties, check-ins — without a status meeting",
          "Tracking hours for payroll",
          "It's the same as the org chart",
        ],
        answerIndex: 1,
        explanation:
          "It answers \"what is this person actually carrying?\" from live data — the question every load-rebalancing and every good 1:1 starts with.",
      },
    ],
  },

  // ── 30 · Management: directing ──────────────────────────────────────────────
  {
    slug: "mgmt-director-philosophy",
    title: "Directing",
    subtitle: "The dial, the absence test, and multiplying instead of doing",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Everything you learned about owning an event scales up one level and becomes directing: you're no longer accountable for one plan happening — you're accountable for a *team of owners* whose plans all happen. The doctrine survives the promotion; only the altitude changes.",
      },
      {
        kind: "table",
        headers: ["Owner's doctrine", "Director's version"],
        rows: [
          ["Delegate work, never accountability", "Delegate AREAS — events, duties, projects — and hold owners to outcomes"],
          ["Oversight is a dial", "A dial PER PERSON: light on proven owners, closer on new ones — and say which setting they're on"],
          ["Build for your own absence", "Build a team that runs without you: runbooks, rotation, a bench"],
          ["Fix the plan, not the moment", "Fix the SYSTEM, not the person — most repeated failures are structure wearing a name"],
        ],
      },
      {
        kind: "rule",
        title: "If most of it resolves to you, you're failing at the actual job",
        text: "The core skill at every level is delegation. A director whose name is on everything isn't heroic — they're a bottleneck with good intentions. Your output is what your people can own without you, not what you personally hold.",
      },
      {
        kind: "p",
        text: "The dial deserves its own sentence: how closely you manage each person is a *setting you choose per person*, based on evidence — check-in history, statuses that stay true, escalations that come early. Turning it down as trust grows is how leaders are made; never turning it down is how they leave.",
      },
      {
        kind: "reveal",
        prompt:
          "Two event leads: one's statuses are always true and blockers arrive early; the other's plan says 'fine' until things are on fire. Same oversight for both?",
        answer:
          "No — and telling them so is the point. The first earns a light dial: read the rings, handle exceptions, stay out of the way. The second gets a closer one — walk the tabs together, verify statuses against reality — WITH the path back stated out loud: \"keep the plan true for two events and I'm gone.\" The dial is feedback, not favoritism.",
      },
      {
        kind: "p",
        text: "And the absence test scales too. Read your team as if you're leaving for a quarter: every duty with a runbook and a healthy owner, every event with a trained lead, every project legible without a meeting — that's the goal state. Every place the answer wobbles is your actual to-do list.",
      },
    ],
    quiz: [
      {
        prompt: "What changes when you go from owning an event to directing?",
        options: [
          "You do more of the tasks yourself",
          "The altitude: you're accountable for a team of owners whose plans all happen — same doctrine, one level up",
          "Accountability ends — your reports carry it all now",
          "You stop using the app",
        ],
        answerIndex: 1,
        explanation:
          "The doctrine survives the promotion. Delegation still creates accountability at each layer, and the outcome still ends with you — the unit is now a team, not a plan.",
      },
      {
        prompt: "How should the oversight dial be set across your team?",
        options: [
          "The same for everyone — fairness means uniformity",
          "Per person, on evidence: light on proven owners, closer on new or struggling ones — with the setting (and the path to lighter) said out loud",
          "Always at maximum — trust is naive",
          "Always at minimum — micromanagement is always wrong",
        ],
        answerIndex: 1,
        explanation:
          "The dial is per-person feedback, not a personality trait. Earned autonomy, stated honestly, is how you grow leaders instead of dependents.",
      },
      {
        prompt: "A director's name is on half the chapter's duties and most of its projects. What does the doctrine say?",
        options: [
          "They're the most valuable person in the chapter",
          "They're failing at the core skill — delegation — and the chapter is one person away from collapse",
          "Nothing, as long as the work gets done",
          "They should get an assistant",
        ],
        answerIndex: 1,
        explanation:
          "A director's output is what their people can own without them. Everything resolving to one person is a bottleneck AND a bus-factor of one — the absence test fails on every line.",
      },
      {
        prompt: "\"Fix the system, not the person\" means…",
        options: [
          "Never hold individuals accountable",
          "When a failure repeats across people, look for the structural cause — a missing runbook, an unclear duty, a bad handoff — before concluding it's a character flaw",
          "Buy better software",
          "Reorganize the team every quarter",
        ],
        answerIndex: 1,
        explanation:
          "Individuals still answer for their commitments (that's the ladder). But a director watches for failures that repeat with different names attached — that pattern is structure, and structure is the director's row to fix.",
      },
    ],
  },

  // ══ Finances (WP-5.1) ════════════════════════════════════════════════════
  // Five role courses (Finances for Everyone / Treasurer / Chapter Director /
  // Financial Manager / Executive Director), authored from the shipped
  // finance surface (Reconcile, the 7-day receipt auto-lock, reimbursements,
  // seats, explicit-only budget attribution, central budgets) — see
  // `docs/plans/finance-v2-split-prd.md` §Phase 5. Where a lesson teaches a
  // workflow that isn't built yet (budget approval, automated skim/launch-
  // grant transfers — both Phase 3/4), a `tip` block says so plainly; the
  // doctrine is real even where the button isn't yet. Content authoring
  // depth here is WP-5.1's "concise starter content" — full depth is WP-5.2.

  // ── 31 · Finances for everyone: stewardship ────────────────────────────────
  {
    slug: "finance-stewardship",
    title: "Where the money comes from",
    subtitle: "Backers, the card, and spending like it's not yours",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Public Worship runs on backers — people who commit real dollars every month because they believe in the mission, not customers buying a product. Every dollar on your card started as someone's monthly gift. That's not guilt-tripping; it's the frame that should sit behind every purchase decision you make.",
      },
      {
        kind: "bullets",
        items: [
          "**A backer gives monthly, not once.** The floor is $50/month — a real, recurring commitment, not a one-time donation.",
          "**Backer count, not backer dollars, drives the model.** Headcount sets the tier a chapter operates at (see the Treasurer and Chapter Director courses) — a chapter grows by adding backers, not by asking existing ones for more.",
          "**The card exists so you don't front cash.** You spend on the mission's behalf; the app tracks it so nobody — including you — has to remember what you're owed.",
        ],
      },
      {
        kind: "rule",
        title: "Spend like a steward, not an owner",
        text: "The money isn't the chapter's to spend however feels right in the moment — it's backers' trust, converted to dollars, for a specific mission. Before a purchase: would you be comfortable a backer saw the receipt?",
      },
      {
        kind: "reveal",
        prompt:
          "You're at the hardware store buying event supplies and spot a discounted item you personally want, same trip. Put it on the Public Worship card?",
        answer:
          "No — even a great deal. The card is for mission spending only; personal items go on your own card, full stop. If a personal charge lands on the church card by accident, flag it immediately (the next lesson) rather than hoping nobody notices.",
      },
    ],
    quiz: [
      {
        prompt: "What actually grows a chapter's operating budget, per the model?",
        options: [
          "Asking current backers to give more each month",
          "Adding more backers — headcount, not total dollars, is the unit the system tracks",
          "Running more events",
          "Cutting operating costs",
        ],
        answerIndex: 1,
        explanation:
          "Tiers and the operating formula key off backer COUNT. A chapter scales by growing its base of backers, not by squeezing more out of the ones it has.",
      },
      {
        prompt: "What is the $50/month backer floor?",
        options: [
          "A one-time donation minimum",
          "The recurring monthly commitment that makes someone a backer",
          "A price for merchandise",
          "A chapter's total monthly budget",
        ],
        answerIndex: 1,
        explanation:
          "A backer gives every month, not once — $50/month is the floor for that ongoing commitment (above-and-beyond giving is separate, on the future Giving page).",
      },
      {
        prompt: "Why track backers by count instead of total dollars raised?",
        options: [
          "Dollars are hard to add up",
          "Headcount is the unit the tier table and operating formula are built on — a stable base of people, not a lump sum, sustains a chapter",
          "It's a legal requirement",
          "Donations aren't recorded individually",
        ],
        answerIndex: 1,
        explanation:
          "Every constant in the model — tiers, the operating formula — is keyed on backer headcount. That's deliberate: people who keep giving matter more than any single big gift.",
      },
      {
        prompt: "You see a discounted personal item while buying event supplies. What's the rule?",
        options: [
          "Buy it on the church card — it was a good deal",
          "Never put personal purchases on the card; flag it immediately if one lands there by accident",
          "Only buy it if it's under $20",
          "Ask your Treasurer first, then buy it either way",
        ],
        answerIndex: 1,
        explanation:
          "The card is mission-only, no exceptions for good deals. An accidental personal charge gets flagged right away, not left for someone else to find later.",
      },
    ],
  },

  // ── 32 · Finances for everyone: card + 7-day rule ──────────────────────────
  {
    slug: "finance-card-and-receipts",
    title: "Your card and the 7-day rule",
    subtitle: "Spend, then close the loop before the grace window ends",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every charge on your Public Worship card needs a receipt attached in the app — not for bureaucracy, but so your Treasurer can close the books without chasing you down a month later. You have **7 days** from the charge to upload one.",
      },
      {
        kind: "table",
        headers: ["Day", "What happens"],
        rows: [
          ["Day of charge", "Charge appears in My Transactions, receipt missing"],
          ["Day 1–3", "A reminder nudges you if the receipt still isn't attached"],
          ["Day 3+", "The reminder escalates — now a flagged charge, visible to your Treasurer"],
          ["Day 7", "No receipt yet → your card **locks automatically**. Uploading the receipt unlocks it immediately."],
        ],
      },
      {
        kind: "rule",
        title: "The lock is a self-service problem",
        text: "Nobody has to ask permission to fix it: the moment you upload the missing receipt, the auto-lock lifts on its own. The rule exists so the Treasurer's monthly close is never blocked on a receipt nobody remembers.",
      },
      {
        kind: "try_status",
        title: "A charge waiting on a receipt",
        options: [
          { value: "none", label: "No receipt yet", color: "gray" },
          { value: "flagged", label: "Reminder sent", color: "amber" },
          { value: "uploaded", label: "Receipt uploaded", color: "green" },
        ],
        terminal: "uploaded",
        caption:
          "Uploading the receipt is the only move that matters — it clears the reminder and the lock, whichever stage you're at.",
      },
    ],
    quiz: [
      {
        prompt: "How long do you have to attach a receipt before your card locks?",
        options: ["24 hours", "7 days", "30 days", "There's no deadline"],
        answerIndex: 1,
        explanation:
          "A charge whose receipt is still missing after 7 days locks the card automatically — the grace window is a week, not a day and not a month.",
      },
      {
        prompt: "Your card auto-locked for a missing receipt from last week. How do you unlock it?",
        options: [
          "Call the Financial Manager",
          "Upload the receipt — the lock lifts automatically, no review needed",
          "Wait for the next reimbursement cycle",
          "You can't; a new card is issued",
        ],
        answerIndex: 1,
        explanation:
          "The unlock is self-service and instant: uploading the missing receipt clears the auto-lock the moment it lands, at any stage.",
      },
      {
        prompt: "Why does the app lock the card instead of just sending more reminders forever?",
        options: [
          "To punish cardholders",
          "An unresolved missing receipt would otherwise block the Treasurer's monthly close — the lock is what finally forces the loop closed",
          "The bank requires it",
          "It's a random security measure",
        ],
        answerIndex: 1,
        explanation:
          "The lock protects the close, not the cardholder's behavior for its own sake — an open loop at month-end is exactly what the Treasurer course teaches you to avoid.",
      },
      {
        prompt: "Where do you see and manage your own card's charges?",
        options: [
          "My Transactions",
          "The central dashboard",
          "The Reconcile grid",
          "You can't see your own charges",
        ],
        answerIndex: 0,
        explanation:
          "My Transactions is your mini-reconcile — attach receipts and flag charges on your own transactions without needing a finance seat.",
      },
    ],
  },

  // ── 33 · Finances for everyone: reimbursements + flags ─────────────────────
  {
    slug: "finance-reimbursements-and-flags",
    title: "Reimbursement, and flagging a charge",
    subtitle: "Two directions: what you're owed, what you owe",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Two situations, two flows. You paid out of pocket for something mission-related? Submit a reimbursement request. A personal charge landed on your Public Worship card by mistake? Flag it — that starts you owing the money back, not the other way around.",
      },
      {
        kind: "bullets",
        items: [
          "**Reimbursement — Public Worship owes you:** submit the request in-app with line items; it moves through submitted → approved → paying → paid. Someone else — never you — has to approve it.",
          "**Personal-charge flag — you owe Public Worship:** flag your own charge as personal on My Transactions, or a manager flags it for you. It opens an owed balance, tracked the same way, just pointed the other direction.",
          "**Both directions live in one place:** the Reimbursements tab shows \"Public Worship owes you\" and \"you owe Public Worship\" side by side, so nothing nets out silently.",
        ],
      },
      {
        kind: "rule",
        title: "Approver ≠ you, always",
        text: "Separation of duties means the person who submits a reimbursement is never the person who approves it — even a Treasurer can't approve their own request. It's the same rule for everyone, including the Executive Director.",
      },
      {
        kind: "try_status",
        title: "A reimbursement request",
        options: [
          { value: "submitted", label: "Submitted", color: "gray" },
          { value: "approved", label: "Approved", color: "amber" },
          { value: "paid", label: "Paid", color: "green" },
        ],
        terminal: "paid",
        caption:
          "Rejected and canceled exist too — those land in your History, not stuck in the middle.",
      },
    ],
    quiz: [
      {
        prompt: "You paid for event supplies with your own card. What do you do?",
        options: [
          "Nothing — it evens out eventually",
          "Submit a reimbursement request with the line items",
          "Ask your Treasurer to send you cash directly",
          "Put it on your Public Worship card retroactively",
        ],
        answerIndex: 1,
        explanation:
          "A reimbursement request is the front door for out-of-pocket mission spending — it's how \"Public Worship owes you\" gets tracked to paid.",
      },
      {
        prompt: "A personal charge accidentally hit your Public Worship card. What's true?",
        options: [
          "It's fine, the card is shared",
          "Flag it — that opens an amount YOU owe Public Worship, tracked until repaid",
          "Nothing happens automatically",
          "Only a manager can notice this, never you",
        ],
        answerIndex: 1,
        explanation:
          "Flagging is available on your OWN transactions, not just to managers — catching your own mistake early is the fastest way to clear it.",
      },
      {
        prompt: "Who can approve your own reimbursement request?",
        options: [
          "You can, if you hold a Treasurer or higher seat",
          "Nobody who is you — SoD requires a different approver every time",
          "Whoever submits it fastest",
          "The Executive Director always, automatically",
        ],
        answerIndex: 1,
        explanation:
          "Approver ≠ requester is identity-based, not role-based — holding a higher seat doesn't let you sign off on your own request.",
      },
      {
        prompt: "Where do you see both directions — what you're owed and what you owe — at once?",
        options: [
          "Two different apps",
          "The Reimbursements tab, side by side",
          "Only in a spreadsheet the Treasurer keeps",
          "You have to ask the Financial Manager",
        ],
        answerIndex: 1,
        explanation:
          "Both directions render together on the same screen — nothing you owe quietly offsets something you're owed without you seeing it.",
      },
    ],
  },

  // ── 34 · Treasurer: the Reconcile grid ─────────────────────────────────────
  {
    slug: "finance-reconcile-grid",
    title: "Running Reconcile",
    subtitle: "Your home screen: code every charge, explicitly",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Reconcile is the Treasurer's spreadsheet-style home: every chapter charge as a row, Category and Budget editable inline, receipts uploaded inline. Nothing here is guessed — a charge only counts against a budget when YOU explicitly link it. There is no automatic matching that quietly assigns spend to the nearest budget.",
      },
      {
        kind: "table",
        headers: ["Filter", "What it catches"],
        rows: [
          ["All", "Every charge, unfiltered"],
          ["Needs budget", "Categorized but not linked to a budget yet"],
          ["Missing receipt", "No receipt uploaded"],
          ["Uncategorized", "No category assigned at all"],
          ["Ready", "Receipt + category + budget all present"],
        ],
      },
      {
        kind: "rule",
        title: "Unattributed is loud on purpose",
        text: "A charge with no explicit budget link doesn't get absorbed into whichever budget looks closest — it shows up as Unattributed on the dashboard, in plain sight, with a one-tap path back into this exact filtered view. Loud and wrong beats quiet and wrong.",
      },
      {
        kind: "try_status",
        title: "One charge, coded",
        options: [
          { value: "unreviewed", label: "Unreviewed", color: "gray" },
          { value: "categorized", label: "Categorized", color: "amber" },
          { value: "reconciled", label: "Reconciled", color: "green" },
        ],
        terminal: "reconciled",
        caption:
          "Excluded is the fourth real status — for charges (like a transfer) that should never count as spend at all.",
      },
    ],
    quiz: [
      {
        prompt: "How does a charge get counted against a budget?",
        options: [
          "The system matches it automatically by category",
          "You explicitly link it to that budget in Reconcile — nothing is derived or guessed",
          "Any charge in the same month as the budget counts",
          "The Chapter Director assigns it",
        ],
        answerIndex: 1,
        explanation:
          "Explicit-only attribution is the whole point: budgets only ever count transactions someone deliberately linked, never inferred matches.",
      },
      {
        prompt: "What does \"Unattributed\" mean on the dashboard?",
        options: [
          "A bug",
          "Spend with no explicit budget link — shown loudly on purpose instead of being silently absorbed somewhere",
          "Money that left the account without a transaction record",
          "Funds waiting on a bank sync",
        ],
        answerIndex: 1,
        explanation:
          "Unattributed is a first-class, visible bucket with a one-tap path into the exact filtered Reconcile view — it's designed to be noticed, not hidden.",
      },
      {
        prompt: "Which Reconcile filter shows charges with no category assigned at all?",
        options: ["Needs budget", "Missing receipt", "Uncategorized", "Ready"],
        answerIndex: 2,
        explanation:
          "Uncategorized is earlier in the pipeline than Needs budget — a charge needs a category before it can be linked to a budget.",
      },
      {
        prompt: "You select 20 charges at once in Reconcile. What can you do?",
        options: [
          "Nothing — only one row at a time can change",
          "Bulk-set their Category, Budget, or mark them Reconciled",
          "Only delete them",
          "Export them to email",
        ],
        answerIndex: 1,
        explanation:
          "Multi-select drives a bulk bar for exactly the actions that make a real month's worth of charges manageable in minutes, not hours.",
      },
    ],
  },

  // ── 35 · Treasurer: chasing receipts ───────────────────────────────────────
  {
    slug: "finance-chasing-receipts",
    title: "Chasing receipts",
    subtitle: "The reminder timeline, and why the lock is your friend",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Cardholders get automatic reminders — you don't have to personally nag every teammate about every charge. Your job is to watch the queue, not manufacture it: escalating cases surface on their own, and the Cards tab shows exactly which cards are approaching the day-7 auto-lock.",
      },
      {
        kind: "bullets",
        items: [
          "**Day 1–3:** a soft reminder goes to the cardholder.",
          "**Day 3+:** the reminder escalates — visible to you as a flagged charge.",
          "**Day 7:** the card locks automatically if the receipt still isn't there. Uploading a receipt at ANY point clears the whole chain, including an already-locked card.",
        ],
      },
      {
        kind: "rule",
        title: "You chase the exceptions, not everyone",
        text: "Most receipts show up before the reminders even matter. Reconcile's Missing receipt filter is your actual worklist — a handful of stragglers each month, not the whole roster.",
      },
      {
        kind: "reveal",
        prompt:
          "A cardholder's card auto-locked three days ago for a missing receipt. They just uploaded it. What do you, the Treasurer, need to do?",
        answer:
          "Nothing — the unlock is automatic the moment the receipt lands. Your job was already done: the reminder timeline and the auto-lock did the chasing for you.",
      },
    ],
    quiz: [
      {
        prompt: "What triggers a card's automatic lock?",
        options: [
          "The Treasurer manually locking it",
          "A charge whose receipt is still missing after 7 days",
          "Reaching a monthly spending cap",
          "Any charge over $500",
        ],
        answerIndex: 1,
        explanation:
          "The day-7 auto-lock is purely about a missing receipt, not spend amount or anyone's manual action.",
      },
      {
        prompt: "A card auto-locked for a missing receipt. Who needs to unlock it?",
        options: [
          "The Financial Manager, by hand",
          "Nobody — uploading the missing receipt unlocks it automatically",
          "The Executive Director",
          "It stays locked until next month",
        ],
        answerIndex: 1,
        explanation:
          "The unlock path is identical to preventing the lock in the first place: upload the receipt and it clears, no review step.",
      },
      {
        prompt: "What's the Treasurer's actual daily worklist for receipts?",
        options: [
          "Personally message every cardholder every day",
          "The Missing receipt filter in Reconcile — the handful of stragglers, not the whole roster",
          "A shared spreadsheet outside the app",
          "There isn't one; it's fully automatic",
        ],
        answerIndex: 1,
        explanation:
          "The reminder timeline handles the routine cases; the filter is where you spend your actual attention.",
      },
    ],
  },

  // ── 36 · Treasurer: the monthly close ──────────────────────────────────────
  {
    slug: "finance-monthly-close",
    title: "The monthly close",
    subtitle: "Everything true in under 30 minutes",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The whole Treasurer job compresses into one target: close the month in under 30 minutes. That's only possible because the work was done continuously — Reconcile kept current, receipts chased as they came due — not saved up for month-end.",
      },
      {
        kind: "rule",
        title: "Close is a check, not a marathon",
        text: "If close is taking hours, the real problem happened three weeks earlier: charges piled up uncategorized, receipts went unchased, budgets went unlinked. A clean close is proof the month was run well, not a task in itself.",
      },
      {
        kind: "bullets",
        items: [
          "**Reconcile at Ready:** every charge has a receipt, a category, and a budget link — the Ready filter's count climbs toward all of them.",
          "**Reimbursement queue triaged:** nothing sitting unreviewed that's actually yours to act on.",
          "**Report up:** the central Financial Manager should be able to open your chapter's numbers and trust them without a conversation — that trust IS the north-star metric this whole system is built around.",
        ],
      },
      {
        kind: "try_ready",
        criteria: [
          "Every charge has a receipt or an explicit personal-charge flag",
          "Every charge is categorized and linked to a budget",
          "The reimbursement queue has nothing waiting on you",
          "Unattributed spend is at zero or explained",
        ],
      },
    ],
    quiz: [
      {
        prompt: "What's the Treasurer's monthly-close target?",
        options: [
          "Under 30 minutes",
          "A full business day",
          "One week",
          "There's no target, just \"eventually\"",
        ],
        answerIndex: 0,
        explanation:
          "Under 30 minutes is the north-star target — and it's only reachable if the month was reconciled continuously, not all at once.",
      },
      {
        prompt: "Why would a close take hours instead of minutes?",
        options: [
          "The app is slow",
          "The real work — reconciling, chasing receipts — didn't happen continuously during the month",
          "There are too many backers",
          "Central hasn't approved the budget yet",
        ],
        answerIndex: 1,
        explanation:
          "A long close is a symptom, not the disease — it means Reconcile and receipt-chasing were deferred instead of done as the month went.",
      },
      {
        prompt: "Who should be able to trust your chapter's numbers without asking you anything?",
        options: [
          "Only you",
          "The central Financial Manager",
          "Every backer individually",
          "Nobody needs to — the numbers are internal",
        ],
        answerIndex: 1,
        explanation:
          "The FM trusting every chapter's numbers without asking is the system's stated north-star metric, right alongside the 30-minute close.",
      },
    ],
  },

  // ── 37 · Chapter Director: raise vs. manage ────────────────────────────────
  {
    slug: "finance-raise-vs-manage",
    title: "Raise vs. manage",
    subtitle: "Three people, three jobs, on purpose",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The playbook splits money into three separate jobs, held by three different humans: the Chapter Director **raises** it (backers), the Treasurer **records** it (Reconcile, receipts, budgets), and the central Financial Manager **oversees** it (audit, cross-chapter trust). As Chapter Director, your finance job is raising and approving — not bookkeeping.",
      },
      {
        kind: "table",
        headers: ["Job", "Who", "What it is NOT"],
        rows: [
          ["Raise", "Chapter Director", "Recording transactions — that's the Treasurer's job"],
          ["Record", "Treasurer", "Fundraising — a Treasurer never fundraises"],
          ["Oversee", "Central Financial Manager", "Day-to-day approval — the FM audits, doesn't run your chapter"],
        ],
      },
      {
        kind: "rule",
        title: "Separation of duties is identity-based, not a courtesy",
        text: "The system enforces approver ≠ requester by the actual person, not by job title — even if you personally hold two seats, you can't approve something you yourself submitted. It's the same protection everywhere in the app, not a special rule just for you.",
      },
      {
        kind: "reveal",
        prompt:
          "As Chapter Director, can you also do the Treasurer's Reconcile work if they're on vacation?",
        answer:
          "You could technically cover the gap, but the playbook's raise/record/oversee split exists precisely so no one person controls all three jobs long-term. Cover a gap; don't make dual-hatting your chapter's normal state — it's a transition condition, not a design.",
      },
    ],
    quiz: [
      {
        prompt: "In the raise/record/oversee split, what does the Chapter Director do?",
        options: [
          "Records every transaction",
          "Raises money (backers) and approves chapter budgets",
          "Audits every other chapter",
          "Issues cards",
        ],
        answerIndex: 1,
        explanation:
          "Raising and approving are the Director's two jobs — recording is the Treasurer's, and cross-chapter audit is the FM's.",
      },
      {
        prompt: "Why does a Treasurer never fundraise?",
        options: [
          "It's against the law",
          "The three jobs are deliberately separated so no one role controls raising, recording, AND approving money",
          "Treasurers dislike fundraising",
          "There's no reason, it's just convention",
        ],
        answerIndex: 1,
        explanation:
          "The three-party separation is the mandated structure the playbook uses to keep any single person from controlling the whole money loop.",
      },
      {
        prompt: "How does the system enforce \"approver ≠ requester\"?",
        options: [
          "By job title only",
          "By the actual person's identity — even a dual-hat holder can't approve their own submission",
          "It doesn't enforce it; it's just a guideline",
          "Only for reimbursements, not budgets",
        ],
        answerIndex: 1,
        explanation:
          "SoD is identity-based (personId + auth email), not role-based, and it applies everywhere approvals happen — reimbursements and budgets alike.",
      },
    ],
  },

  // ── 38 · Chapter Director: approving budgets ───────────────────────────────
  {
    slug: "finance-approving-budgets",
    title: "Approving budgets",
    subtitle: "The 85% principle — and what's live today vs. coming",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Within your chapter's 85% (what's left after the skim to central), you approve freely — the playbook's rule is mission/vision confines, not central sign-off. Central's role is auditing your numbers after the fact, not gating your spending before it.",
      },
      {
        kind: "rule",
        title: "The 85% principle",
        text: "Inside your chapter's own operating money, the Chapter Director approves budgets that fit the chapter's mission and vision — full stop. Central never pre-approves a chapter budget; the Financial Manager's oversight is audit, not a gate.",
      },
      {
        kind: "bullets",
        items: [
          "**Who approves what:** a chapter budget is approved by you (the Chapter Director); your Treasurer can also approve one if you were the one who submitted it — separation of duties always picks whoever ISN'T the requester.",
          "**Central budgets are the mirror image:** approved by the Executive Director, or the Financial Manager if the ED submitted it.",
          "**Over the approved cap:** spending past what a budget allows raises a loud warning today — it doesn't block the card yet.",
        ],
      },
      {
        kind: "tip",
        text: "**Coming soon:** the actual submit → approve/changes-requested workflow (a button in the app) isn't built yet — it's a near-term addition to the finance system. Until it ships, get sign-off the way chapters do it today: a real conversation with whoever approves, before the spending starts. This lesson teaches the doctrine that workflow will enforce, not a screen you can tap through yet.",
      },
      {
        kind: "reveal",
        prompt:
          "Your Treasurer submits a budget they wrote for their own project. Can they approve it themselves?",
        answer:
          "No — separation of duties applies to budgets exactly like reimbursements: whoever submits can never be the one who approves, even a Treasurer on their own project. It routes to you, the Chapter Director, instead.",
      },
    ],
    quiz: [
      {
        prompt: "Within a chapter's 85%, who approves how the money gets spent?",
        options: [
          "Central has to sign off on everything first",
          "The Chapter Director, freely, within mission/vision — central doesn't pre-approve chapter budgets",
          "Nobody — it's unrestricted",
          "The Treasurer alone",
        ],
        answerIndex: 1,
        explanation:
          "The 85% principle is explicit: chapters approve freely within their own money; central's control is audit, not a gate.",
      },
      {
        prompt: "What is central's role in a chapter's budget, per the 85% principle?",
        options: [
          "Approving every line item",
          "Auditing after the fact — oversight, not a gate",
          "Setting the chapter's spending limit line by line",
          "Central has no visibility at all",
        ],
        answerIndex: 1,
        explanation:
          "The Financial Manager's cross-chapter audit is oversight after the money moves, not pre-approval before it does.",
      },
      {
        prompt: "Is the in-app budget-approval workflow (submit → approve) live today?",
        options: [
          "Yes, fully live",
          "Not yet — it's a near-term addition; approval today happens by conversation, not a button",
          "It was live and was removed",
          "Only for central budgets",
        ],
        answerIndex: 1,
        explanation:
          "Budget line items and the approval state machine are Phase 3 work — the doctrine is real now, the button is coming.",
      },
    ],
  },

  // ── 39 · Chapter Director: tiers, the covenant, and the skim ───────────────
  {
    slug: "finance-tiers-and-skim",
    title: "Tiers, the covenant, and the skim",
    subtitle: "What backer count buys you, and what goes back to central",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A chapter's backer count — headcount, never dollars — sets its tier, and every tier unlocks more of the mission. This is the covenant: chapters commit to raising; central commits to what the tiers promise.",
      },
      {
        kind: "table",
        headers: ["Backers", "Tier unlocks"],
        rows: [
          ["20", "Worship With Strangers (WWS) — the baseline program"],
          ["30", "+ Eden"],
          ["50", "+ LTN"],
        ],
      },
      {
        kind: "p",
        text: "The chapter operating formula is $520 fixed + $50 per teammate, plus a conference sinking fund per funded seat (~$275÷12 for a driving city, ~$500÷12 for a flight). For a 5-person team that floor lands around $770/month — film, food, transport, storage, software, the ordinary costs of running the mission.",
      },
      {
        kind: "rule",
        title: "The skim funds the next city",
        text: "Every month, a flat **15%** of chapter revenue moves — as a real transfer, not a budget line — from the chapter's account to central's City Launch Fund. That fund is what pays a new city's ~$7,800–8,300 launch cost (equipment + the training trip) when it's ready to start.",
      },
      {
        kind: "reveal",
        prompt:
          "Your chapter crosses 31 backers this month. What tier are you in, and does the extra backer above 30 change your skim rate?",
        answer:
          "You're at the 30-backer tier (+Eden unlocked) until you reach 50. The skim rate stays a flat 15% regardless of tier — more backers means more revenue, and 15% of more is more, but the percentage itself doesn't change.",
      },
    ],
    quiz: [
      {
        prompt: "What sets a chapter's tier?",
        options: [
          "Total dollars raised in a year",
          "Backer headcount — the 20/30/50 thresholds",
          "How many events the chapter runs",
          "How long the chapter has existed",
        ],
        answerIndex: 1,
        explanation:
          "Tiers are keyed on backer count, exactly like every other constant in the model — headcount, never dollars.",
      },
      {
        prompt: "What percentage of chapter revenue moves to central each month?",
        options: [
          "A flat 15%, as a real transfer to the City Launch Fund",
          "0% — chapters keep everything",
          "50%",
          "It varies by chapter size",
        ],
        answerIndex: 0,
        explanation:
          "The skim is flat 15% for every chapter, modeled as an actual transfer, not just a number on a report.",
      },
      {
        prompt: "What does the City Launch Fund pay for?",
        options: [
          "Chapter operating expenses",
          "A new city's one-time launch cost — equipment and the training trip",
          "Reimbursements",
          "Backer refunds",
        ],
        answerIndex: 1,
        explanation:
          "The fund exists specifically to seed the NEXT city — every chapter's skim is an investment in the network growing.",
      },
      {
        prompt: "Does reaching a higher backer tier change the skim percentage?",
        options: [
          "Yes, higher tiers pay a higher percentage",
          "No — the skim stays a flat 15% regardless of tier; more backers just means more total revenue",
          "Yes, it drops as chapters grow",
          "The skim only starts after 50 backers",
        ],
        answerIndex: 1,
        explanation:
          "The percentage is constant; only the base it's applied to grows as a chapter adds backers.",
      },
    ],
  },

  // ── 40 · Financial Manager: cross-chapter audit ────────────────────────────
  {
    slug: "finance-cross-chapter-audit",
    title: "Auditing every chapter",
    subtitle: "The central rollup, drill-down, and the trust you're building",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "As Financial Manager, your dashboard opens to the central view: every chapter as a row in one rollup, each with its month's spend against its budget. Tap a chapter and you're inside its own dashboard — the same view its Treasurer sees — so you can verify, not just skim a summary number.",
      },
      {
        kind: "bullets",
        items: [
          "**By-chapter rollup:** every chapter, plus Central itself as its own row — spend, budget, and status side by side.",
          "**Drill-down:** open any chapter and see exactly what its Treasurer sees, real numbers, not a redacted export.",
          "**By-tag rollup:** an org-wide breakdown tappable into the contributing budgets across chapters.",
        ],
      },
      {
        kind: "rule",
        title: "Trust, not permission",
        text: "You're not a gate a chapter's spending waits behind — you're the person who can look at any chapter's numbers at any time and vouch for them. The north-star metric for this whole system is exactly that: you trust every chapter's numbers without having to ask anyone.",
      },
      {
        kind: "reveal",
        prompt:
          "A chapter's dashboard shows a large Unattributed balance this month. What's your move as Financial Manager?",
        answer:
          "Drill into that chapter's Reconcile — the same one-tap path its Treasurer has — and see what's sitting unlinked. It's a conversation starter with the Treasurer, not a punishment: Unattributed being visible at all is the system working; ignoring it would be the failure.",
      },
    ],
    quiz: [
      {
        prompt: "What does the central rollup show?",
        options: [
          "Only central's own budgets",
          "Every chapter as a row — spend vs budget — plus Central's own row",
          "A single combined number with no chapter breakdown",
          "Nothing until a chapter submits a report",
        ],
        answerIndex: 1,
        explanation:
          "The rollup is per-chapter, side by side, with Central appearing as a row exactly like every chapter — nothing is pre-aggregated away.",
      },
      {
        prompt: "When you drill into a chapter from the central view, what do you see?",
        options: [
          "A summary PDF",
          "The exact same dashboard that chapter's own Treasurer sees",
          "Nothing — drill-down is view-only metadata",
          "Only that chapter's card list",
        ],
        answerIndex: 1,
        explanation:
          "Drill-down re-checks your central reach and then shows the chapter's real dashboard — the FM's audit tool IS the chapter's own view.",
      },
      {
        prompt: "What's the FM's actual relationship to a chapter's spending?",
        options: [
          "A gate every purchase must pass first",
          "An auditor who can verify any chapter's numbers at any time — oversight, not pre-approval",
          "No relationship — chapters are fully independent",
          "The FM personally approves every transaction",
        ],
        answerIndex: 1,
        explanation:
          "The FM audits and can escalate receipt-chasing, but chapter budgets are approved by the Chapter Director, not pre-cleared by the FM.",
      },
    ],
  },

  // ── 41 · Financial Manager: the receipt escalation queue ───────────────────
  {
    slug: "finance-receipt-escalation-queue",
    title: "The receipt escalation queue",
    subtitle: "Watching for cards nearing the day-7 lock, chapter-wide",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The same receipt timeline every cardholder lives under — reminder, escalation, day-7 auto-lock — rolls up to you across every chapter. The Cards view's escalation queue is where you see which cards are closest to locking, before it happens.",
      },
      {
        kind: "table",
        headers: ["Stage", "What it means for you"],
        rows: [
          ["Flagged (day 1–3)", "Still routine — the cardholder likely hasn't noticed yet"],
          ["Escalated (day 3+)", "Worth a nudge if it's a repeat pattern for that person"],
          ["Locked (day 7)", "Automatic — no action needed from you; it lifts the moment a receipt lands"],
        ],
      },
      {
        kind: "rule",
        title: "You watch patterns, not individual charges",
        text: "One missing receipt is normal life. The same cardholder hitting escalation every month is the thing worth a real conversation — the queue is there so you notice the pattern, not so you personally chase every stray charge.",
      },
      {
        kind: "try_status",
        title: "A charge moving through the timeline",
        options: [
          { value: "active", label: "Active, no issue", color: "gray" },
          { value: "flagged", label: "Flagged", color: "amber" },
          { value: "escalated", label: "Escalated", color: "amber" },
          { value: "cleared", label: "Receipt uploaded — cleared", color: "green" },
        ],
        terminal: "cleared",
        caption:
          "Notice the card never needs YOU to unlock it — a receipt landing at any stage clears the whole chain.",
      },
    ],
    quiz: [
      {
        prompt: "What does the FM's escalation queue surface?",
        options: [
          "Every single charge in the system",
          "Cards approaching or past the day-7 receipt auto-lock, across all chapters",
          "Only locked cards",
          "Budget approval requests",
        ],
        answerIndex: 1,
        explanation:
          "The queue is scoped to the receipt timeline specifically — the FM's cross-chapter view of the exact same mechanic every member lives under.",
      },
      {
        prompt: "A cardholder hits \"escalated\" once this month. What's the right response?",
        options: [
          "Lock their card personally right away",
          "Nothing unusual — one instance is normal; a repeating pattern for the same person is what's worth a conversation",
          "Report them to the Executive Director",
          "Cancel their card",
        ],
        answerIndex: 1,
        explanation:
          "The queue exists to catch PATTERNS across months, not to turn a single late receipt into an incident.",
      },
      {
        prompt: "Who unlocks a card that hit the day-7 auto-lock?",
        options: [
          "The Financial Manager, manually, each time",
          "Nobody has to — uploading the missing receipt unlocks it automatically",
          "It requires an Increase support ticket",
          "It stays locked for 30 days regardless",
        ],
        answerIndex: 1,
        explanation:
          "The unlock mechanic is identical for every seat — receipt lands, lock lifts, no manual review anywhere in the chain.",
      },
    ],
  },

  // ── 42 · Financial Manager: accounts, cards, and the City Launch Fund ──────
  {
    slug: "finance-accounts-and-cards-admin",
    title: "Accounts, cards, and the City Launch Fund",
    subtitle: "The ED/FM-only administration surface",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every chapter — and central itself — has its own Increase account, provisioned automatically. Central's own account is where the City Launch Fund balance actually lives. The Accounts tab that shows all of this is visible ONLY to Executive Director and Financial Manager seats; chapters never see it, they just have a working card program.",
      },
      {
        kind: "bullets",
        items: [
          "**Accounts tab:** a quiet status/audit view — account health, not a place chapters configure anything.",
          "**Card lifecycle you administer:** cancel/close a card (FM + Treasurer only), and approve card requests members submit (a member requests, you or the Treasurer approve, then it issues).",
          "**Self-serve freeze is everyone's own, not yours to grant:** any cardholder can freeze their OWN card instantly if they suspect foul play — deliberately outside your queue so nobody waits on you to protect themselves.",
        ],
      },
      {
        kind: "rule",
        title: "Opaque by design",
        text: "The accounts layer became fully automatic and opaque on purpose — no one pastes in an Increase account ID anymore, no chapter picks a bank account from a dropdown. Your visibility into it is a deliberate exception for exactly two seats: ED and FM.",
      },
      {
        kind: "reveal",
        prompt:
          "A member emails asking you to freeze their card because their phone was stolen. What do you tell them?",
        answer:
          "They don't need you — self-serve freeze is instant and theirs alone to trigger, right from their own Cards tab. Point them there first; it's faster than waiting on you, and it's built that way on purpose.",
      },
    ],
    quiz: [
      {
        prompt: "Who can see the Accounts tab?",
        options: [
          "Every finance seat",
          "Only Executive Director and Financial Manager seats",
          "Every chapter member",
          "Only the account's original creator",
        ],
        answerIndex: 1,
        explanation:
          "Accounts visibility is tighter than general finance-seat access — ED and FM only, chapters never see it.",
      },
      {
        prompt: "Where does the City Launch Fund's balance actually live?",
        options: [
          "A spreadsheet central maintains manually",
          "Central's own Increase account — central has an account just like every chapter",
          "Split evenly across all chapter accounts",
          "It's a virtual number with no real account",
        ],
        answerIndex: 1,
        explanation:
          "Central is provisioned its own real account (WP-1.2), and that account is the City Launch Fund's actual home.",
      },
      {
        prompt: "A cardholder suspects their card was compromised. Who freezes it?",
        options: [
          "Only the Financial Manager can freeze any card",
          "The cardholder themselves, instantly, via self-serve freeze — no need to wait on the FM",
          "Only the Treasurer",
          "It requires an Increase support ticket",
        ],
        answerIndex: 1,
        explanation:
          "Self-serve freeze is distinct from the receipt auto-lock and exists specifically so nobody waits on a manager to protect themselves.",
      },
      {
        prompt: "Who can cancel/close a card outright?",
        options: [
          "Any cardholder, self-serve",
          "FM and Treasurer seats only",
          "Only the Executive Director",
          "It can never be canceled, only frozen",
        ],
        answerIndex: 1,
        explanation:
          "Cancel/close is a heavier action than freeze and is restricted to FM and Treasurer seats, not the cardholder themselves.",
      },
    ],
  },

  // ── 43 · Executive Director: central budgets ───────────────────────────────
  {
    slug: "finance-central-budgets",
    title: "Central budgets",
    subtitle: "Central's own money, planned the same way a chapter's is",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Central isn't a bookkeeping abstraction — it has its own budgets, its own line, and its own row in every rollup, using the exact same budget machinery every chapter uses. A central budget's chapter field is literally the string \"central\", not a null or a special case bolted onto the side.",
      },
      {
        kind: "bullets",
        items: [
          "**New budget, central scope:** created the same way a chapter budget is, just scoped to central instead of a chapter.",
          "**Central's rollup row:** sits alongside every chapter in the by-chapter view, with the identical drill-down behavior.",
          "**What lives here:** central operating costs, the City Launch Fund balance, and — as launch grants come online — the money that seeds new cities.",
        ],
      },
      {
        kind: "rule",
        title: "One system, one set of rules",
        text: "Central spending follows the same invariants as chapter spending: actuals come only from explicitly-linked transactions, an over-cap budget gets a loud warning, and approval follows the mirror-image of a chapter's SoD — you approve central budgets, and the Financial Manager approves if you were the one who submitted it.",
      },
      {
        kind: "reveal",
        prompt:
          "Why does central use the exact same budget tables and rules as a chapter, instead of its own separate system?",
        answer:
          "Because \"central\" is just another scope in the same model (a sentinel string, not a parallel structure) — every rule, report, and rollup that works for a chapter works for central automatically, with nothing built twice.",
      },
    ],
    quiz: [
      {
        prompt: "How is a central budget represented in the system?",
        options: [
          "A completely separate table from chapter budgets",
          "The same budget structure, scoped with the sentinel value \"central\" instead of a chapter",
          "A null chapterId",
          "A spreadsheet outside the app",
        ],
        answerIndex: 1,
        explanation:
          "Central is a string sentinel, never null — the deliberate pattern this codebase uses everywhere central needs to be its own scope.",
      },
      {
        prompt: "Where does central appear in the by-chapter rollup?",
        options: [
          "It doesn't — central is invisible there",
          "As its own row, with the same drill-down every chapter gets",
          "Only as a footnote at the bottom",
          "Central has a separate dashboard with no rollup at all",
        ],
        answerIndex: 1,
        explanation:
          "Central gets a real row in the rollup, not special-cased out of it — the whole point of treating it as a scope, not an exception.",
      },
      {
        prompt: "Who approves a central budget you didn't personally submit?",
        options: [
          "You, the Executive Director",
          "Only the Treasurer",
          "No one — central budgets don't need approval",
          "Every chapter director votes",
        ],
        answerIndex: 0,
        explanation:
          "Central budget approval mirrors a chapter's: the ED approves, and SoD only reroutes to the FM if the ED was the one who submitted it.",
      },
    ],
  },

  // ── 44 · Executive Director: governance and seats ──────────────────────────
  {
    slug: "finance-governance-and-seats",
    title: "Governance and seats",
    subtitle: "One seat, one holder — and the honest seat switcher",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The Governance page is where seats get assigned: Executive Director and Financial Manager at central, Chapter Director and Treasurer per chapter. Each is one holder per seat — assigning a new Executive Director replaces the old one, it doesn't add a second.",
      },
      {
        kind: "table",
        headers: ["Seat", "Scope", "In UI copy"],
        rows: [
          ["Executive Director", "Central only", "Executive Director"],
          ["Financial Manager", "Central or chapter", "Financial Manager (central) / Treasurer (chapter)"],
          ["Chapter Director", "Chapter only", "Chapter Director"],
        ],
      },
      {
        kind: "p",
        text: "Today, some people genuinely hold two real seats at once — you might be Executive Director AND a Chapter Director. That's not a bug or a special permission: if you hold seats at both central and a chapter, you get an honest **seat switcher** (\"which desk are you at?\") that lists exactly your real seats. Someone with one seat never sees a switcher at all.",
      },
      {
        kind: "rule",
        title: "Dual-hatting is a phase, not a design",
        text: "The playbook's end state has no one holding both a central and a chapter seat — dual-hatting exists only because a city is small early on. As chapters grow their own leadership, the seat switcher naturally has less and less to switch between.",
      },
      {
        kind: "reveal",
        prompt:
          "You're seated as both Executive Director and a Chapter Director. The finance dashboard opens — what decides which view you land on?",
        answer:
          "Your seat switcher lets you pick which desk you're at; the dashboard then shows exactly that seat's real view. There's no \"preview\" mode pretending to be a seat you don't hold — only your genuine seats, listed honestly.",
      },
    ],
    quiz: [
      {
        prompt: "How many holders can one seat (e.g. Executive Director) have at once?",
        options: [
          "Unlimited",
          "One — assigning a new holder replaces the old one",
          "Two, for redundancy",
          "It depends on chapter size",
        ],
        answerIndex: 1,
        explanation:
          "Seats are one-holder slots per (scope, title) — a new assignment replaces, it never stacks.",
      },
      {
        prompt: "Who sees a seat switcher in the finance dashboard?",
        options: [
          "Everyone, always",
          "Only someone who genuinely holds seats at both central and a chapter",
          "Only the Executive Director",
          "Nobody — switchers were removed entirely",
        ],
        answerIndex: 1,
        explanation:
          "Single-seat holders never see a switcher — it exists purely for the real, transition-period case of holding two real seats.",
      },
      {
        prompt: "What does the playbook say about dual-hatting long-term?",
        options: [
          "It's the permanent design",
          "It's a transition state that should empty out as chapters mature — no one holds both a central and chapter seat at steady state",
          "It should apply to every leader",
          "It only applies to Treasurers",
        ],
        answerIndex: 1,
        explanation:
          "The playbook explicitly calls for no dual-hatting across central and chapter once a city is established — today's overlap is a startup condition.",
      },
    ],
  },

  // ── 45 · Executive Director: launch grants + the skim transfer ─────────────
  {
    slug: "finance-launch-grants-and-transfers",
    title: "Launch grants and the skim transfer",
    subtitle: "What's live today, and what's coming with Phase 4",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Two money flows tie the whole network together: the 15% skim moving UP from every chapter into the City Launch Fund, and a one-time launch grant moving DOWN from central to seed a brand-new city. The fund itself is real today — it's central's own account. Moving money automatically along both directions is coming next.",
      },
      {
        kind: "table",
        headers: ["Flow", "Direction", "What it funds"],
        rows: [
          ["The skim", "Chapter → Central, monthly", "The City Launch Fund"],
          ["Launch grant", "Central → new chapter, one-time", "Equipment (~$4,300) + the training trip (~$3,500–4,000)"],
        ],
      },
      {
        kind: "rule",
        title: "The fund exists; the pipe doesn't, yet",
        text: "The City Launch Fund's balance is a real number in a real central account you can see today. What's still ahead: the skim transfer running itself every month, and a launch grant that stamps a new chapter's launch budget automatically the day it's approved.",
      },
      {
        kind: "tip",
        text: "**Coming soon:** both flows will be modeled as `transfer` rows once built (Phase 4 of the finance roadmap) — excluded from category/budget spend like any transfer, so they never distort a chapter's or central's real operating numbers. Until then, treat the skim and launch grants as manual moves you track, not automated ones the app runs for you.",
      },
      {
        kind: "reveal",
        prompt:
          "A brand-new city is ready to launch. Where does its ~$7,800–8,300 in equipment and training-trip funding come from?",
        answer:
          "The City Launch Fund — the pool every existing chapter has been feeding with its monthly 15% skim. The fund's balance is real and visible today; the one-time transfer that hands it to the new chapter is the part still being built.",
      },
    ],
    quiz: [
      {
        prompt: "What does the City Launch Fund pay for?",
        options: [
          "Ongoing chapter operating costs",
          "A new city's one-time launch cost — equipment and training trip",
          "Reimbursements to individual members",
          "Central's own salaries",
        ],
        answerIndex: 1,
        explanation:
          "The fund's entire purpose is seeding the next city's launch — a one-time cost, not recurring operations.",
      },
      {
        prompt: "Is the monthly skim transfer automated today?",
        options: [
          "Yes, fully automatic",
          "The fund's balance is real today; automating the transfer itself is a coming addition",
          "It was automated then removed",
          "It only runs once a year",
        ],
        answerIndex: 1,
        explanation:
          "Central's account and the fund balance are live now (WP-1.2); the automatic monthly transfer is Phase 4 work, still ahead.",
      },
      {
        prompt: "Why will skim and launch-grant transfers be modeled as `flow:\"transfer\"` rows once built?",
        options: [
          "So they count double toward budgets",
          "So they're excluded from category/budget spend, like any money movement that isn't a mission purchase",
          "It's a legal requirement",
          "So central pays less tax",
        ],
        answerIndex: 1,
        explanation:
          "Transfers are excluded from category/budget spend everywhere in this system — the skim and launch grants are money MOVEMENTS, not purchases, and must never distort actuals.",
      },
    ],
  },
];

/**
 * The ordered curriculum. `order` is frozen from array position (1-based) so
 * it is always contiguous — the sequential-unlock chain in the backend walks
 * `order ± 1` and would silently break on duplicated or gapped numbers.
 */
export const ACADEMY_SECTIONS: AcademySection[] = SECTIONS_IN_ORDER.map(
  (s, i) => ({ ...s, order: i + 1 }),
);

/** Total number of curriculum sections (including optional bonus sections). */
export const ACADEMY_SECTION_COUNT = ACADEMY_SECTIONS.length;

/**
 * How many sections count toward "fully trained" — optional bonus sections
 * are excluded. This is the denominator progress UIs and completion counts use.
 */
export const ACADEMY_REQUIRED_SECTION_COUNT = ACADEMY_SECTIONS.filter(
  (s) => s.optional !== true,
).length;

/** The capstone sections, in curriculum order. */
export const ACADEMY_CAPSTONE_SECTIONS: AcademySection[] =
  ACADEMY_SECTIONS.filter((s) => s.capstone != null);

/** Look up a section by slug, or undefined. */
export function getAcademySection(slug: string): AcademySection | undefined {
  return ACADEMY_SECTIONS.find((s) => s.slug === slug);
}

/** The section after this one in curriculum order, or undefined at the end. */
export function nextAcademySection(slug: string): AcademySection | undefined {
  const current = getAcademySection(slug);
  if (!current) return undefined;
  return ACADEMY_SECTIONS.find((s) => s.order === current.order + 1);
}

/** The section before this one in curriculum order, or undefined at the start. */
export function previousAcademySection(
  slug: string,
): AcademySection | undefined {
  const current = getAcademySection(slug);
  if (!current) return undefined;
  return ACADEMY_SECTIONS.find((s) => s.order === current.order - 1);
}
