/**
 * The Events stream — the core curriculum: what Chapter OS is, running an
 * event through its tabs, being an owner, and the six capstones (join an
 * event, birthday party, the optional worship bonus, and the three role
 * capstones). Also the Events theme + its five courses.
 *
 * Owned exclusively by this file for content authoring — do not add Events
 * sections or courses anywhere else. See `../index` for how this assembles
 * into the full curriculum/catalog.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Events-stream sections, in curriculum order. */
export const EVENTS_SECTIONS: Omit<AcademySection, "order">[] = [
  // ── 1 · What Chapter OS is ──────────────────────────────────────────────────
  {
    slug: "what-is-events-os",
    title: "What Chapter OS is",
    subtitle: "One place for the whole plan",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Chapter OS holds an event's plan in one place: every task, message, supply, permit, and person. It replaces the group chat, the spreadsheets, and somebody's memory.",
      },
      {
        kind: "rule",
        title: "The plan lives in the app, not in a head",
        text: "Anyone on the team can open the event and see what's left, whose it is, and when it's due.",
      },
      {
        kind: "bullets",
        items: [
          'A **template** is the reusable blueprint for a *kind* of event, such as "Worship With Strangers", "Eden", or one you make. It holds the roles, the tabs, and the standard to-dos with their timing.',
          "An **event** is one dated copy of a template. Creating an event copies the whole structure and turns every \"10 days before\" into a real due date. After that, you edit the event freely.",
        ],
      },
      {
        kind: "p",
        text: "Templates hold what's **always** true. Events hold what's true **this time**. Edit the event for a this-time fix. If it will matter at every future event, fix the *template*.",
      },
      {
        kind: "story",
        title: "Eden, 2026",
        text: 'Eden is the flagship gathering this app grew out of. Its debrief said *"we needed trash bags."* The fix was a **new supplies row in the template**, so no future event can forget them.',
      },
      {
        kind: "reveal",
        prompt:
          "Sound check ran long for the third event in a row. Quick note, or template change?",
        answer:
          'Template change. "Third time in a row" means *always*. Move the sound-check call time earlier in the template, and every future event inherits the fix.',
      },
    ],
    quiz: [
      {
        prompt: "What's the difference between a template and an event?",
        options: [
          "A template is read-only; an event can be edited by admins",
          "A template is the reusable blueprint for a kind of event; an event is one dated copy of it",
          "They're the same thing: 'event' is a template with a date",
          "Templates are for big events, events are for small ones",
        ],
        answerIndex: 1,
        explanation:
          "Templates hold what's ALWAYS true for a kind of event. An event copies that structure for one date and is then freely editable. Later template edits never change an in-flight event.",
      },
      {
        prompt:
          "This Saturday's venue has two entrances, so you need an extra welcome table. Where does that change go?",
        options: [
          "In the event: it's true this time, not always",
          "In the template: every change goes in the template",
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
          "Learnings become TEMPLATE changes, so every future event inherits the fix. That exact fix came out of Eden's real debrief.",
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
        text: "Two kinds of people work on every event, and Chapter OS treats them differently.",
      },
      {
        kind: "table",
        headers: ["Who", "What they do", "What they need"],
        rows: [
          [
            "**Organizers**",
            "Plan for weeks: own tabs, keep statuses true, make the calls",
            "This app, which this training teaches",
          ],
          [
            "**Crew**",
            "Show up day-of to fill a role: run the welcome table, grill, play a set, shoot photos",
            "A call time, a duty, and a contact, **not** the app",
          ],
        ],
      },
      {
        kind: "p",
        text: "Crew can be volunteers (your uncle on the grill) or paid help (a photographer, a hired musician). Both go on the event's **Crew** list with a status (invited, then confirmed) and a call time. What each crew team does is written in **Crew Duties** *before* anyone is recruited into it.",
      },
      {
        kind: "rule",
        title: "Organizers plan; crew execute",
        text: "If someone's job starts and ends on event day, they're crew. They never need to open this app. The plan gives them their team, their contact, their call time, and their duty.",
      },
      { kind: "heading", text: "The best organizers might not be there" },
      {
        kind: "p",
        text: "A well-planned event runs without its planner on site. If your event only works when you're there, the plan still lives in your head. Strong organizers hand a fully planned event to the day-of team, every time. When you *do* attend, you can be present instead of firefighting.",
      },
      {
        kind: "reveal",
        prompt:
          "Your friend agreed to run sound during the event. Organizer or crew?",
        answer:
          "Crew: it's a day-of role. Add them to the Crew list with a call time and their duty. If they also plan the audio setup weeks out and own supply rows, they're an organizer too.",
      },
    ],
    quiz: [
      {
        prompt: "Who is Chapter OS built for?",
        options: [
          "Everyone who attends the event",
          "Organizers: the people planning and helping plan",
          "Only the single event lead",
          "The venue and the vendors",
        ],
        answerIndex: 1,
        explanation:
          "The app is for organizers. Crew (people filling a day-of role) get what they need FROM the plan: call time, duty, contact. They never open the app.",
      },
      {
        prompt:
          "Your cousin is showing up Saturday morning to help set up chairs, then staying for the event. What are they?",
        options: [
          "An organizer: they're doing work",
          "Crew: their job starts and ends on event day",
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
          "That's the goal. A plan that runs without its author shows nothing lived in anyone's head. The best organizers do this consistently.",
      },
    ],
  },

  // ── 3 · Anatomy of an event ────────────────────────────────────────────────
  {
    slug: "anatomy-of-an-event",
    title: "Anatomy of an event",
    subtitle: "Tabs, rows, statuses, and roles",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every event has tabs. Each tab is one **area** of the plan: one owned slice of the work. Seven come built in, and each gets its own short section after this one:",
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
        text: "A chapter can add custom tabs (a merch stand, a food operation) and turn off tabs an event doesn't need. Every tab is a table of **rows**. A row is one unit of work, such as a task, a message, or a supply item. Every row has a **title**, a **status**, and a **person it resolves to**.",
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
          "Every row on every tab works like this chip. The event's readiness numbers are computed from statuses, so a stale status misleads the whole team.",
      },
      { kind: "heading", text: "Roles: assign hats, then people" },
      {
        kind: "p",
        text: "Templates attach work to **roles** (Event Lead, Comms Lead, Logistics Lead, Production Lead), and each event puts one person in each role. So a template written in New York works in Austin: the work follows the role, not the person. **One person per role, per event.** Helpers are crew. Follow the chain to see who's on the hook for a row:",
      },
      { kind: "try_chain" },
      {
        kind: "rule",
        title: "Every row ends at one human",
        text: "Row owner, then the row's role, then that role's person, then the tab's owner, then the event owner. If the chain dead-ends, the row is **unowned**, and unowned work quietly doesn't happen.",
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
          "Every tab is a table of rows. Every row (task, message, supply, permit) carries the same three things: title, status, accountable person.",
      },
      {
        prompt: "Why do templates assign work to roles instead of people?",
        options: [
          "Because names change too often to store",
          "So the same template works with any team: the work follows the role, not the person",
          "Roles are cheaper to store",
          "So nobody feels personally responsible",
        ],
        answerIndex: 1,
        explanation:
          "The template says 'Comms Lead does this', and each event puts one person in that role. The template works in any city and stays clear when people swap.",
      },
      {
        prompt:
          "Two capable friends both want to co-own the Run of Show. What does the app expect?",
        options: [
          "Assign both: more owners, more done",
          "One holds the role and is accountable; the other helps as crew",
          "Split the tab in two",
          "Let the assistant own it",
        ],
        answerIndex: 1,
        explanation:
          "One person per role per event. Shared ownership is how 'I thought you had it' happens. Helpers are crew.",
      },
      {
        prompt: "A row has no owner and no role. What happens to it?",
        options: [
          "It's optional, so nothing needs to happen",
          "It escalates to the chapter admin",
          "It lands on the event owner (the end of the chain) until they hand it to someone",
          "It gets deleted automatically",
        ],
        answerIndex: 2,
        explanation:
          "The accountability chain always ends at the event owner. Anything that falls through every other hand is theirs until they place it.",
      },
    ],
  },

  // ── 4 · Being an owner ─────────────────────────────────────────────────────
  {
    slug: "being-an-owner",
    title: "Being an owner",
    subtitle: "Accountability, oversight, and building for your own absence",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every row, tab, and event resolves to an owner. **Doing work and owning work are two different jobs.** Most people start as doers, with rows that carry their name. An owner is measured by whether the *whole thing* happens, not by rows finished.",
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
            "Is the person the gap lands on: finds it, rows it, places it",
          ],
        ],
      },
      {
        kind: "rule",
        title: "If it doesn't happen, it's on you",
        text: "You can delegate every piece of the work, never the accountability. Delegation done right creates accountability at each layer: someone handed a clear row (details, timing, owner) owns getting it done.",
      },
      {
        kind: "p",
        text: "Oversight is a dial. With role-holders who keep statuses true, owning is light: read the rings, scan What's-next, handle exceptions. With a team that updates the plan inconsistently, turn the dial up. Walk the tabs, ask people what's true, and fix the plan until it matches reality. Someone has to keep the rings honest, and below the best teams that's you.",
      },
      {
        kind: "reveal",
        prompt:
          "You own the event. At T-8 the Comms tab says the announcement is still 'Drafted', and the Comms Lead hasn't touched a status in a week. What's the owner move?",
        answer:
          "Turn the dial up, through the person: ask the Comms Lead what's true, get the statuses honest, and unblock anything stuck. Don't quietly do it yourself (the plan stays wrong and the lead learns to lean on you). Don't just wait (the outcome is still yours).",
      },
      {
        kind: "p",
        text: "The owner's test: read the plan as if you won't be there. If every role-holder follows their rows, **does the event happen?** Every wobble is a gap: a missing row, an unowned row, a detail only in your head. Then shape the work into **roles**: usually an event lead, comms, and logistics, adding production or more as the event and your hands grow. Each role gets whole areas, one person per role.",
      },
      {
        kind: "tip",
        text: "Ask the assistant: \"If I disappeared today, what breaks? What's unowned, undated, or only in my head?\" It reads the live rows to answer.",
      },
    ],
    quiz: [
      {
        prompt: "What changes when you go from doing rows to OWNING an area or event?",
        options: [
          "You do all the rows yourself now",
          "You're accountable that the whole thing happens: every row exists, resolves to someone, and gets done",
          "You only attend the meetings",
          "Nothing: owner is a label for the busiest person",
        ],
        answerIndex: 1,
        explanation:
          "A doer is measured by their rows, an owner by the outcome. Gaps land on the owner: if something needed lacks a row, an owner, or timing, fixing that is your job.",
      },
      {
        prompt:
          "Your role-holders keep every status true and nothing sits unowned. How much active oversight do you owe?",
        options: [
          "The same as always: walk every tab daily no matter what",
          "Little: read the rings and What's-next, handle exceptions. A strong team turns the dial down",
          "None: a good team means the owner can check out",
          "More: good teams need more supervision",
        ],
        answerIndex: 1,
        explanation:
          "Oversight scales with how consistently the team keeps the plan true. It never reaches zero: the owner still verifies the rings are honest.",
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
          "Read the plan as if you'll be absent. Every place it would wobble without you is a gap: a missing row, an unowned row, a detail only in your head.",
      },
      {
        prompt:
          "You handed the Comms area to a lead with clear duties, details, and timing. A message never goes out. Who's accountable?",
        options: [
          "Nobody: plans fail sometimes",
          "Only you: delegation keeps all accountability with the owner",
          "Only the comms lead: you delegated it away",
          "Both, at different layers: the lead owns their area's outcome, and the event is still on you",
        ],
        answerIndex: 3,
        explanation:
          "Delegation hands over the work and creates accountability at the new layer. It never removes yours: every layer answers for its slice, and the event ends at the owner.",
      },
      {
        prompt: "How does an owner carve an event into roles?",
        options: [
          "One role per task, so nothing is shared",
          "Start with event lead, comms, and logistics, and add roles as the event and the available hands grow: whole areas per role, one person per role",
          "Everyone shares all the roles for flexibility",
          "Roles are only for events over 100 people",
        ],
        answerIndex: 1,
        explanation:
          "Shape the work into slices someone can own. The trio covers most events, and bigger events with more hands add production and beyond. Helpers are crew.",
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
        text: 'Put real dates in a spreadsheet, move the event a week, and every date is wrong. Chapter OS stores timing as an **offset** instead: "10 days before the event." In T-notation, **T-10** is 10 days before, **T-0** is event day, and **T+2** is two days after.',
      },
      { kind: "try_offset", eventDateLabel: "Worship With Strangers" },
      {
        kind: "p",
        text: "The numbers come from **your template**. Announce at T-14, lock volunteers by T-10, pack supplies by T-1: these are the defaults our worship templates ship with, learned from real events. They aren't rules of the app. Planning something smaller? Change the number. If the new number works better, change the *template*.",
      },
      {
        kind: "p",
        text: "Horizons scale with the event. A flagship gathering starts **months** out, and venues and permits can need T-60 or more. A backyard party still needs two weeks. **Two weeks is the floor** for planning anything involving other people, not the standard length.",
      },
      {
        kind: "rule",
        title: "A task without timing is invisible",
        text: "Due dates come from offsets, and reminder emails come from due dates. A row with no timing never lands on anyone's list, so give every task an offset, even a rough one.",
      },
      {
        kind: "story",
        title: "Eden, 2026",
        text: "Eden applied for its park permit with plenty of runway and *still didn't get it*. It survived because the plan had slack and a written fallback. Anything on someone else's clock starts as early as possible, with a plan B.",
      },
      {
        kind: "tip",
        text: "Reschedule from **Details** in the event header, and every derived due date moves with the date. Outside lead times don't move: a park permit still takes weeks, a custom order still ships in days. Re-check permits and orders yourself.",
      },
    ],
    quiz: [
      {
        prompt: "The event moves from June 7 to June 14. What happens?",
        options: [
          "Nothing: dates and tasks are independent",
          "Every offset-derived due date shifts automatically, but lead-time work (permits, orders) needs a manual re-check",
          "All tasks reset to Not started",
          "Only day-of tasks move",
        ],
        answerIndex: 1,
        explanation:
          "Offsets re-derive due dates automatically. Permits and shipping follow the real world, not your calendar, so re-check them after every reschedule.",
      },
      {
        prompt: 'Your template says "announce at T-14" but your event is a small pop-up planned 10 days out. What do you do?',
        options: [
          "Cancel: the template's rule can't be met",
          "Announce at T-14 anyway by backdating",
          "Change the offset on your event; if the new timing works well, improve the template",
          "Skip the announcement entirely",
        ],
        answerIndex: 2,
        explanation:
          "Template numbers are defaults, not rules of the app. Events adapt freely, and good adaptations go back into the template.",
      },
      {
        prompt: "Why does every task need an offset, even a rough one?",
        options: [
          "The app refuses to save rows without one",
          "Offsets drive due dates, and due dates drive reminders: an untimed task never lands on anyone's list",
          "It makes the grid look complete",
          "Offsets are required for the budget rollup",
        ],
        answerIndex: 1,
        explanation:
          "A task without timing has no due date and no reminder. Even a rough offset puts it on someone's list.",
      },
      {
        prompt: "What did Eden's park permit teach the playbook?",
        options: [
          "Permits are optional for outdoor events",
          "Apply as early as possible and write a fallback: approval is never in your hands",
          "Permits only take a day or two",
          "Only paid events need permits",
        ],
        answerIndex: 1,
        explanation:
          "Eden applied in time and still got denied. Slack and a written plan B saved it. Lead-time work starts at kickoff and always carries a fallback.",
      },
    ],
  },

  // ── 6 · The four phase rings ───────────────────────────────────────────────
  {
    slug: "phase-rings",
    title: "The four rings",
    subtitle: "Pre-plan, Planning, Day-of, Post, and staying on pace",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every event header shows four rings. They're computed from your real rows, and each one answers a different question:",
      },
      {
        kind: "table",
        headers: ["Ring", "The question", "What moves it"],
        rows: [
          [
            "**Pre-plan**",
            "Is the event set up to be planned?",
            "Roles filled, area owners assigned, template-marked cells checked off, Comms and Permits marked ready",
          ],
          [
            "**Planning**",
            "Is the prep on track?",
            "Every row due *before* the event (T-minus tasks, messages, permits, supply buying and ordering), plus locking Run of Show, Crew Duties, Supplies",
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
        text: "A row's tab and timing decide its ring automatically. Debrief rows are always Post. Crew Duties are always Day-of. Supplies count twice. *Getting* an item (order, buy, pull from storage) follows its timing and counts as Planning. *Packing* it always counts toward Day-of, even when you pack early. Everything else follows its offset: before the event feeds Planning, on the day feeds Day-of, after feeds Post. **Pre-plan** isn't statuses. It's the setup checklist: people in roles, owners on areas, and the cells your template flagged for check-off.",
      },
      { kind: "heading", text: "Am I where I should be?" },
      {
        kind: "p",
        text: "A percentage alone can't tell you if you're in trouble: 40% planned is great two months out and a crisis at three days. So each ring has a pace check: **is anything in this phase overdue?** If not, it shows a green **\"✓ on pace\"**. If so, an amber **\"▲ 3 overdue\"**, counting the same rows the What's-next list flags. A dashed tick marks your **baseline**: your score with every overdue row cleared. It moves up when you finish things early, so working ahead shows.",
      },
      {
        kind: "rule",
        title: "The rings only tell the truth you tell them",
        text: "Every number here comes from row statuses and due dates. A stale status throws off the pace math the whole team uses. Update statuses the day things happen.",
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
        text: "Tap any ring on the event header and the tabs that feed it pulse, showing what moves that number.",
      },
    ],
    quiz: [
      {
        prompt: "What makes the Pre-plan ring different from the other three?",
        options: [
          "It's the only one an admin can edit",
          "It tracks the setup checklist (roles, area owners, flagged cells), not row statuses",
          "It's computed from the budget",
          "It only appears on large events",
        ],
        answerIndex: 1,
        explanation:
          "Planning, Day-of, and Post are computed from row statuses and timing. Pre-plan is the check-off layer: people in roles, owners on areas, and the cells your template marked for confirmation.",
      },
      {
        prompt: "Which ring does a Debrief row feed?",
        options: [
          "Planning",
          "Day-of",
          "Post, always",
          "Whichever the owner picks",
        ],
        answerIndex: 2,
        explanation:
          "Tab and timing sort rows automatically. Debrief rows are always Post, Crew Duties always Day-of. Supplies split (buying feeds Planning, packing feeds Day-of), and everything else follows its offset.",
      },
      {
        prompt: "Your Planning ring reads 20% with \"▲ 6 overdue\" under it. What does that mean?",
        options: [
          "The ring is broken",
          "You've done 20% of the whole event",
          "Six of that phase's rows are past due and not done (the same rows the What's-next list flags), and clearing them is today's job",
          "The template requires 6 more tasks before you can continue",
        ],
        answerIndex: 2,
        explanation:
          "If anything in a phase is overdue, its ring says so, with the count. The ring and the What's-next list read the same rows, so they always agree.",
      },
      {
        prompt: "Why does a stale status matter more than it seems?",
        options: [
          "It doesn't: statuses are just labels",
          "The rings and pace math are computed from statuses, so one stale row throws off the numbers everyone uses",
          "Stale statuses get auto-deleted",
          "It blocks other people from editing the row",
        ],
        answerIndex: 1,
        explanation:
          "The rings only work if owners keep statuses true the day things happen. That's why 'the area tells the truth' is expectation #1.",
      },
    ],
  },

  // ── 7 · Tasks ──────────────────────────────────────────────────────────────
  {
    slug: "tab-tasks",
    title: "Tasks",
    subtitle: "The master to-do list, and what does NOT go on it",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The **Tasks** tab is the event's master to-do list. Default owner: the Event Lead. A row with no owner and no role belongs to the **tab owner**, so leaving Owner blank assigns the task to the Event Lead. Book the venue, confirm the worship leader: anything that isn't a message, an item, a recruit, paperwork, or a day-of segment. Not sure where something goes? Put it in Tasks and move it later.",
      },
      {
        kind: "p",
        text: "The most common mistake is a task that belongs on another tab. The tell: the specialist tab tracks what a task row can't, such as cost and packing for supplies, confirmations and call times for crew, deadlines and documents for permits.",
      },
      {
        kind: "table",
        headers: ["Sounds like a task…", "Where it lives"],
        rows: [
          [
            '"Buy lawn games" / "Order napkins"',
            "**Supplies & Logistics**: a physical item, with source, cost, link, and a have-it-by date",
          ],
          [
            '"We need a videographer"',
            "**Crew Duties**: write the duty on the Content team, then fill the slot with a volunteer or a paid vendor",
          ],
          [
            '"Post the announcement"',
            "**Comms Schedule**: a message, with audience, channel, and timing",
          ],
          [
            '"Secure the park permit"',
            "**Permits**: paperwork on someone else's clock, with a deadline and the document attached",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Write it once, where it lives",
        text: "Two copies of one fact means one goes stale, and soon nobody trusts either. If the work is already a supply, comms, crew, or permit row, that row is the plan. Don't shadow it with a task.",
      },
      {
        kind: "reveal",
        prompt:
          '"We need someone to film the event." You\'re about to tap + Add row on Tasks. What do you do?',
        answer:
          "Open Crew Duties instead. Write the duty on the Content team (\"shoot recap clips: worship, crowd, the gospel moment\"), then fill the slot. Use a volunteer, or a hired videographer as paid crew with an amount. The unfilled slot shows recruiting isn't done. A task named \"find videographer\" hides that.",
      },
      {
        kind: "p",
        text: 'A real task row has **details a stranger could act on**, a status, timing, and who it resolves to. "Sound permit via precinct officer, ~3 days prior, permit holder must attend" beats "get sound permit". If someone said "I\'ll handle it," there\'s a row with their name on it.',
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
          "Update statuses the day things happen. The readiness numbers are computed from them.",
      },
      {
        kind: "tip",
        text: "Rows sort by due date, so top to bottom is the timeline. **Overdue rows are flagged red**, and finished rows whose dates have passed fade out. **Me view** filters every tab to just your rows.",
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
          "Buying things is a Supplies & Logistics row. That tab tracks what a task can't: source, cost, link, quantity, a have-it-by date, and packing. Booking, scheduling, and confirming are true tasks.",
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
          "Recruiting lives in Crew Duties. The duty says what the job is. The slot tracks who fills it (volunteer or paid), with confirmation, call time, and for vendors an amount that rolls into the budget.",
      },
      {
        prompt:
          'Tasks has a row "Secure the sound permit" and the Permits tab has a sound-permit row. What\'s wrong?',
        options: [
          "Nothing: redundancy is safety",
          "The task should have an owner too",
          "The same fact lives twice, so one copy WILL go stale. The Permits row is the plan; delete the shadow task",
          "The permit row should move to Tasks",
        ],
        answerIndex: 2,
        explanation:
          "Write it once, where it lives. Duplicated rows drift apart, and the team stops trusting both. The Permits row carries the deadline and the document, so it's the one to keep.",
      },
      {
        prompt: 'Why is "Sound permit via precinct officer, ~3 days prior, holder must attend" a better row than "Get sound permit"?',
        options: [
          "It's longer, so it looks more thorough",
          "Details a stranger could act on mean the task survives the person who knew how",
          "Short titles break the grid",
          "The assistant requires full sentences",
        ],
        answerIndex: 1,
        explanation:
          "Anyone should be able to run the plan without asking around. Details carry the how and the why so anyone can pick the row up cold.",
      },
      {
        prompt: "A task row has no owner and no role. Whose is it?",
        options: [
          "Nobody's: it's optional",
          "The tab owner's: for Tasks, the Event Lead",
          "The last person who edited it",
          "The assistant's",
        ],
        answerIndex: 1,
        explanation:
          "An unowned row defaults to whoever owns the tab, on every tab. Area owners fill in owners, or everything blank is theirs.",
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
        text: "Every message the event sends is a row, and each column answers one question about it. Default owner: the Comms Lead, so a comms row with no owner is theirs.",
      },
      {
        kind: "table",
        headers: ["Column", "The question it answers"],
        rows: [
          ["**Comm**", "What is this message? (\"Announcement\", \"T-1 call-time reminder\")"],
          ["**Status**", "Not started, then Drafted, then Scheduled, then **Sent** (the only terminal state)"],
          ["**Timing / Date**", "When does it go out? An offset (T-7) that derives the real date"],
          ["**Channel**", "Where does it post: IG, the iMessage group, email, Google Chat?"],
          ["**Audience**", "Who is it for: leaders, volunteers, attendees, the public?"],
          ["**Owner**", "Who sends it. Blank means the Comms Lead, the tab's owner"],
          ["**Notes / copy**", "The actual message text lives here, not in someone's drafts folder"],
        ],
      },
      {
        kind: "p",
        text: "Use it for the announcement, the volunteer ask, reminders, the day-of \"here's the pin, here's how to find us\", and thank-yous after. If it reaches people outside the planning team, it's a row here.",
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
          "Sent is the terminal state. A drafted message helps nobody find the park.",
      },
      {
        kind: "p",
        text: "Our templates remind volunteers at T-7, T-3, *and* T-1. That repetition is how twenty people show up at the same spot at the same time. Thank-yous are planned rows too: day-of to crew, T+1 to attendees. Thanking people is how they come back.",
      },
      {
        kind: "rule",
        title: "If it isn't scheduled, it doesn't get sent",
        text: "Every audience (public, attendees, crew, leaders) should hear from you in every phase. A volunteer who hears nothing between the ask and event day often doesn't show.",
      },
      {
        kind: "tip",
        text: "One hard gate: **never announce a venue that isn't locked.** The announcement row waits on the venue row.",
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
          "Comms rows are messages: announcement, asks, reminders, thank-yous. Each carries audience, channel, timing, and the actual copy.",
      },
      {
        prompt: "Volunteers get reminders at T-7, T-3, AND T-1. Why?",
        options: [
          "The app sends them automatically no matter what",
          "Repetition is how twenty people show up at the same place and time",
          "It fills out the schedule so it looks planned",
          "One reminder is legally insufficient",
        ],
        answerIndex: 1,
        explanation:
          "That cadence comes from real events. Repetition is the difference between 'invited' and 'present'.",
      },
      {
        prompt: "The venue isn't confirmed yet, but the announcement post is ready. Send it?",
        options: [
          "Yes: momentum matters most",
          "Yes, but delete it if the venue falls through",
          "No: never announce an unconfirmed venue; the announcement waits on the venue lock",
          "Only if the event is under two weeks out",
        ],
        answerIndex: 2,
        explanation:
          "This is a hard gate. Announcing an unlocked venue can mean re-announcing a move to your whole audience, or people showing up at the wrong park.",
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
          "The copy lives on the row, so anyone can send it, including whoever covers for you. A message in your drafts can't go out when you're unavailable. (An unowned comms row belongs to the Comms Lead, the tab's owner.)",
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
        text: "Put everything that happens on the day here, in order. Setup, sound check, the huddle, and strike are real segments with real owners, because that's where the day goes wrong.",
      },
      {
        kind: "rule",
        title: "Every segment has one named owner",
        text: '"All" is acceptable only for arrival, setup, and strike. A segment owned by everyone is owned by no one, and people stand around in front of your guests.',
      },
      {
        kind: "reveal",
        prompt:
          "Guests have arrived and it's time to shift from background music into the worship set. Who makes that call?",
        answer:
          "Whoever owns that segment, by name, on the row. If the row says a team or \"all\", nobody moves.",
      },
      {
        kind: "p",
        text: "Call times live here too. Work backwards from start: team arrival, setup, sound check, doors. Arrive *earlier* than feels necessary. In a public space you can't reserve your spot, so you occupy it.",
      },
      {
        kind: "tip",
        text: "Lock the run of show a few days out. Our templates lock at T-3, because the T-3 and T-1 reminder messages quote its call times.",
      },
    ],
    quiz: [
      {
        prompt: "How are Run of Show rows timed?",
        options: [
          "In days before the event, like tasks",
          "In minutes from event start: negative before, positive after",
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
          "Everything that happens on the day is a segment, especially setup, sound check, huddle, and strike, because that's where days go wrong.",
      },
      {
        prompt: "Why lock the run of show a few days before the event?",
        options: [
          "Because printing takes three days",
          "Reminder messages quote its call times, so an unlocked run of show means reminders with wrong times",
          "The app locks it automatically anyway",
          "So the venue can approve it",
        ],
        answerIndex: 1,
        explanation:
          "The T-3 and T-1 reminders pull call times from these rows. That's why our templates lock the run of show at T-3.",
      },
    ],
  },

  // ── 10 · Crew Duties ────────────────────────────────────────────────────────
  {
    slug: "tab-crew-duties",
    title: "Crew Duties",
    subtitle: "Who's coming day-of, and what each team does",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "This tab has two halves. The **Crew list** holds every volunteer and paid helper, with their team, a status (invited, then confirmed), and a call time. The **duty rows** say what each team does: \"Welcome ×6: greet, direct, hand out connect cards.\" Default owner: the Comms Lead, so duty rows with no owner are theirs.",
      },
      {
        kind: "bullets",
        items: [
          "**1. Name your teams.** The Team column's options are the event's team list. Teams are day-of *functions*: Welcome, Food & Bev, Production, Content, Prayer. (\"Budget\" and \"Venue research\" are planning work, not crew teams.)",
          "**2. Write each team's duties.** One row per expectation, with details of what done looks like. This is the job someone says yes to.",
          "**3. Fill the slots.** Recruit people into teams. A volunteer friend and a hired videographer go on the same crew list. Paid crew carry an amount and an unpaid-to-paid status that rolls into the budget.",
          "**4. Chase to confirmed, with call times.** Invited is a maybe; only confirmed counts. Every confirmed crew member gets a call time.",
        ],
      },
      {
        kind: "rule",
        title: "Needing a person is a duty and an open slot, not a task",
        text: '"We need a videographer" is an unfilled role. Write the duty (Content team: "shoot recap clips"), then fill it with a volunteer or a vendor. The open slot shows where recruiting stands. A task named "find someone" hides it.',
      },
      {
        kind: "try_status",
        title: "Jordan: Welcome team",
        options: [
          { value: "invited", label: "Invited", color: "gray" },
          { value: "confirmed", label: "Confirmed", color: "green" },
        ],
        terminal: "confirmed",
        caption:
          "Invited is a maybe. A crew list full of 'invited' three days out is a list of holes, so chase confirmations early.",
      },
      {
        kind: "rule",
        title: "Write duties before you recruit",
        text: "Without written duties, recruits show up with no idea what to do. Write the team duties first, then post the ask. Every crew member then knows five things before they arrive: their team, their contact, their call time, what to wear, what to bring.",
      },
      {
        kind: "p",
        text: "Crew never need the app. The briefing page carries those five things out to them.",
      },
      {
        kind: "reveal",
        prompt:
          "It's five days out. Your crew list shows 8 people: 3 confirmed, 5 invited. How worried are you?",
        answer:
          "Worried enough to act today. You have 3 crew and 5 maybes. Chase every 'invited' now, while there's time to recruit replacements. Our templates treat unconfirmed crew inside T-10 as urgent.",
      },
    ],
    quiz: [
      {
        prompt: "What are the two halves of the Crew Duties tab?",
        options: [
          "A budget and a schedule",
          "The crew list (who, with status and call time) and duty rows (what each team does)",
          "Organizers and attendees",
          "Invites and thank-yous",
        ],
        answerIndex: 1,
        explanation:
          "WHO is coming lives on the crew list. WHAT each team does lives in the duty rows.",
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
          "Teams are day-of functions (Welcome, Food & Bev, Production, Content, Prayer): stations that need people at the event. Budget, venue research, and permits are planning work on other tabs, owned by organizers.",
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
          "Volunteers and paid help are both crew: same list, same call times. Paid crew add an amount and unpaid-to-paid tracking in the budget rollup.",
      },
      {
        prompt: "Why do duties get written BEFORE the volunteer ask goes out?",
        options: [
          "The app blocks recruiting until they exist",
          "So you recruit people into specific, known jobs instead of collecting people with no idea what to do",
          "Because duties can't be edited later",
          "To make the tab look complete",
        ],
        answerIndex: 1,
        explanation:
          "People say yes to a clear job and show up knowing their team, contact, call time, dress, and gear.",
      },
      {
        prompt: "What does 'invited' mean on the crew list?",
        options: [
          "They're coming",
          "They're a maybe: only 'confirmed' counts",
          "They've been paid",
          "They declined",
        ],
        answerIndex: 1,
        explanation:
          "Invited is not confirmed. A list of 'invited' near event day is a list of holes. Chase confirmations early enough to recruit replacements.",
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
        text: "Every physical item the event needs is a row. Default owner: the Logistics Lead, so an item with no owner is theirs to bring. The tab also holds the **site map**: a drawing of the venue (stage, stations, tables, arrival flow) with supplies and crew placed on it. Walk the site and map it before the event.",
      },
      {
        kind: "table",
        headers: ["Column", "The question it answers"],
        rows: [
          ["**Status**", "How close is it to in-hand? **Auto-derived** from Source, Packed-in, and the Inventory registry. Ends at **Have it**"],
          ["**Timing / Due**", "When must you HAVE it? Orders need shipping time, so set it weeks out, not T-1"],
          ["**Source**", "Where does it come from, and where does it return? **Chapter Storage** links (and reserves) an Inventory asset; Borrowed/Rented come back to a person or vendor; Buy/Order are acquired"],
          ["**Packed in**", 'Which container? "Green luggage" beats "somewhere"'],
          ["**Qty · Cost · Link**", "How many, what it costs (feeds the budget), where to re-order it"],
          ["**Owner**", "Who's bringing it. Blank = the Logistics Lead"],
        ],
      },
      {
        kind: "p",
        text: "Every item is two jobs. **Getting it** happens early: online orders weeks ahead, store runs a few days out. The Timing column is its deadline, and it feeds the Planning ring. **Packing it** happens at the end: everything in hand by T-1, checked into its container. Packing feeds the Day-of ring, even when you pack early.",
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
          "Status ends at Have it: in your hands, not \"on the way\". This battery leaves storage early enough to charge at home, because there's no charger in storage. (The original checklist marked this \"VERY IMPORTANT\".)",
      },
      {
        kind: "rule",
        title: "Packing is a checklist, not a status",
        text: "Packed-or-not is tracked in ONE place: the Packing checklist, where items group by container and get checked in (and back out at strike). Status stops at Have it, so it can never claim \"packed\" when the trunk says otherwise.",
      },
      {
        kind: "bullets",
        items: [
          "Status is **derived** from facts you already recorded. Packed into a real container means **Have it**.",
          "A **Chapter Storage** row watches its linked Inventory asset: available shows *Pull from storage*; an out-of-stock consumable shows *Need to buy*.",
          "Borrowed shows *Need to pick up*; Rented shows *Need to rent*; an online order goes *Need to order*, then *Ordered*.",
          "When reality disagrees, hand-pick a status. The row marks it overridden, and one tap goes **back to auto**.",
        ],
      },
      {
        kind: "p",
        text: "Setting Source to **Chapter Storage** links the row to an Inventory asset (pick one or create it from the row) and *reserves* it for this event. Another event listing the same speaker sees **Event X · Green luggage**: who has it and which container it's in. A bought item worth keeping gets promoted with **Keep in inventory**, an explicit action, never automatic.",
      },
      {
        kind: "tip",
        text: "Once you HAVE something, update **Source** and notes with where it lives: *\"with Maya\"*, *\"Sam's garage\"*. Keep **Cost** and **Link** current: cost rolls into the event budget, and the link lets the next event re-order.",
      },
    ],
    quiz: [
      {
        prompt: "What's the terminal STATUS for a supply item?",
        options: [
          "Packed",
          "Have it: status tracks acquisition; packing is tracked on the Packing checklist",
          "Ordered",
          "Pull from storage",
        ],
        answerIndex: 1,
        explanation:
          "Status walks an item to in-hand and stops at Have it. Packed-or-not lives only on the Packing checklist, so a status can never contradict the trunk.",
      },
      {
        prompt: "You just picked up the borrowed speaker and marked it Have it. What else does the row need?",
        options: [
          "Nothing: Have it says it all",
          "Update Source/notes with where it lives now, so whoever packs knows where to grab it",
          "A new task on the Tasks tab",
          "Set its status back to Ordered for the record",
        ],
        answerIndex: 1,
        explanation:
          "Have it answers \"do we have it?\" Source answers \"WHERE is it?\" The packer may not be the person who fetched it, so the row carries the location.",
      },
      {
        prompt: "What is the site map?",
        options: [
          "A photo of the venue from Google Maps",
          "The venue layout drawing (stage, stations, arrival flow) with supplies and crew placed on it",
          "A list of driving directions",
          "The run of show in graphical form",
        ],
        answerIndex: 1,
        explanation:
          "The site map lives with Supplies & Logistics because it shows where everything the grid tracks goes.",
      },
      {
        prompt:
          "Your row for the shared speaker shows \"Worship Night · Green luggage\" instead of Pull from storage. Why?",
        options: [
          "It's a display bug: refresh",
          "The speaker's Inventory asset is reserved by Worship Night; the row shows who has it and where it's packed",
          "Someone typed that in as a custom status",
          "The speaker was deleted from Inventory",
        ],
        answerIndex: 1,
        explanation:
          "A Chapter Storage row reserves its linked asset. When another live event holds it, your row shows which event and which container, so you find the clash in planning, not on load-in day.",
      },
      {
        prompt:
          "You bought a folding table the chapter should keep. How does it get into Inventory?",
        options: [
          "Every bought supply row is added automatically",
          "Promote it with \"Keep in inventory\": creating the asset from the row is an explicit action",
          "Ask an admin to re-type it on the Inventory tab",
          "It can't: Inventory only holds storage items",
        ],
        answerIndex: 1,
        explanation:
          "Most supply rows are consumables, and auto-creating assets would flood the registry. Durable gear is promoted on purpose: the row's name, quantity, and photo carry across, and the row links to the new asset.",
      },
    ],
  },

  // ── 11b · Keeping inventory ─────────────────────────────────────────────────
  {
    slug: "keeping-inventory",
    title: "Keeping inventory",
    subtitle: "The chapter's gear registry, and how events borrow from it",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The **Inventory** tab is the chapter's gear registry. Each durable thing the chapter owns is one row: name, **tags** (audio, power, signage…), how many you own, a photo, and its condition. Check it before anyone buys something the chapter may already have.",
      },
      {
        kind: "rule",
        title: "Inventory holds durable, chapter-owned gear only",
        text: "Consumables you'll buy again (ice, wristbands), borrowed items, and rentals stay on the event's supply list. A bought item enters the registry only when someone promotes it with \"Keep in inventory\", never automatically.",
      },
      {
        kind: "p",
        text: "An event claims gear from its own supplies grid. A row with **Source = Chapter Storage** links an asset, and the link *reserves* that many for the event. The registry computes **available = owned − reserved by live events**. When the event completes, its hold releases on its own, with no return to file. Two overlapping events can't both have the one battery.",
      },
      {
        kind: "p",
        text: "Chapter-owned **consumables** (gaffer tape, zip ties) get used up, not returned. Mark the asset consumable and give it a low-stock threshold. The registry badges **Low stock** and **Out of stock**, and every event row linked to an empty consumable derives to *Need to buy*. Keep **condition** honest too: mark a broken speaker *needs attention* with a note (\"crackles above half volume\").",
      },
      {
        kind: "reveal",
        prompt:
          "Two Saturday events both list the chapter's one ALTO speaker. Event A linked it Tuesday; Event B adds its row Thursday. What does Event B see?",
        answer:
          "Event B's row shows **Event A · {container}** the moment it links the asset. Event B finds out Thursday in planning, not Saturday at load-in, with two days to borrow, rent, or talk to Event A.",
      },
      {
        kind: "tip",
        text: "Tags drive the filter pills above the grid. Use consistent tags (audio, power, lighting, staging, cabling, signage, transport) so finding all the sound gear takes one tap.",
      },
    ],
    quiz: [
      {
        prompt: "How does an event reserve chapter gear?",
        options: [
          "Email the Logistics Lead",
          "A supplies row with Source = Chapter Storage, linked to the asset: listing the need IS the reservation",
          "Edit the asset's quantity down on the Inventory tab",
          "Reservations aren't tracked",
        ],
        answerIndex: 1,
        explanation:
          "The supply row's link claims the asset for the event, and the registry's availability updates live for everyone else.",
      },
      {
        prompt: "An event that reserved the speaker just completed. Who returns the reservation?",
        options: [
          "The Logistics Lead files a return",
          "Nobody: availability is computed from LIVE events, so the hold releases automatically",
          "An admin resets the registry weekly",
          "The next event's lead clears it",
        ],
        answerIndex: 1,
        explanation:
          "Available = owned − reserved by live events. A completed or cancelled event drops out of the sum on its own, so the registry can't go out of date like a manual log.",
      },
      {
        prompt: "What belongs in the Inventory registry?",
        options: [
          "Every supply any event ever listed",
          "Durable chapter-owned gear; consumables, borrowed, and rented items stay on event supply lists",
          "Only items worth more than $100",
          "Whatever the assistant adds automatically",
        ],
        answerIndex: 1,
        explanation:
          "The registry answers \"what do we own?\" Auto-adding every bought supply would bury the real gear, so promotion via Keep in inventory is a person's call.",
      },
      {
        prompt: "The chapter's gaffer tape (consumable) hits zero. What happens on events that listed it?",
        options: [
          "Nothing until someone notices",
          "Their linked rows derive to Need to buy: the shortage reaches every plan that needs it",
          "Their events are cancelled",
          "The rows silently unlink",
        ],
        answerIndex: 1,
        explanation:
          "Stock counts live in one place, and every linked event row reads its status from them in real time.",
      },
    ],
  },

  // ── 12 · Permits ───────────────────────────────────────────────────────────
  {
    slug: "tab-permits",
    title: "Permits",
    subtitle: "Paperwork on someone else's clock",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "Public worship happens in public space, so it needs park permits, amplified-sound permits, and sometimes food permits. Each permit is a row: jurisdiction contact, deadline, status, and the document attached once granted. Default owner: the Event Lead.",
      },
      {
        kind: "p",
        text: "Use it for any event in a space you don't control. Backyard hangout? Toggle the tab off, since not every event needs every tab. Public park with a speaker? Start at kickoff.",
      },
      {
        kind: "try_status",
        title: "Park permit: Maria Hernandez Park",
        options: [
          { value: "to_apply", label: "To apply", color: "red" },
          { value: "submitted", label: "Submitted", color: "amber" },
          { value: "approved", label: "Approved", color: "green" },
        ],
        terminal: "approved",
        caption:
          "Approved is the only terminal state. Submitted means the government is still deciding.",
      },
      {
        kind: "rule",
        title: "Approval is never in your hands",
        text: "Permits run on someone else's lead time. Apply at kickoff, and write every permit's \"what if denied\" line before you need it.",
      },
      {
        kind: "table",
        headers: ["Permit", "Lead time", "Learned the hard way"],
        rows: [
          ["Park / venue", "3+ weeks", "Eden applied in time and still got denied. The fallback saved the event"],
          ["Amplified sound", "~3 days", "Via the local precinct; the permit holder must be on site"],
          ["Food", "Weeks, often blocked", "Requires proof of insurance. Know your contact before you need one"],
        ],
      },
    ],
    quiz: [
      {
        prompt: "When do permit applications start?",
        options: [
          "The week of the event",
          "At kickoff: they start now and resolve later",
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
          "Toggle it off: not every event needs every tab",
          "Delete the template",
          "Leave it empty forever",
        ],
        answerIndex: 1,
        explanation:
          "Tabs are toggleable per event and per template. An event only carries the areas it uses.",
      },
      {
        prompt: "Every permit row should carry a \"what if denied\" line. Why?",
        options: [
          "The city requires it",
          "Because approval is never in your hands: the fallback is written while you're calm, not improvised at T-2",
          "It speeds up the application",
          "It's needed for the budget",
        ],
        answerIndex: 1,
        explanation:
          "A written fallback (different spot, no amplification, adjusted food plan) makes a denial survivable.",
      },
    ],
  },

  // ── 13 · Debrief ───────────────────────────────────────────────────────────
  {
    slug: "tab-debrief",
    title: "Debrief",
    subtitle: "How the next event gets easier",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "After the event, while memories are fresh (our templates say within a week), the team captures four things: what went well, what broke, what was missing, what was excess. Each is a row on the Debrief tab. Default owner: the Event Lead.",
      },
      {
        kind: "p",
        text: "Every row then gets **dispatched** to one of three fates: *promoted* into the template, kept as *context* for future teams, or *dropped* on purpose. A row left sitting is a lesson nobody learns.",
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
          "Actioned means dispatched: promoted to the template, logged as context, or dropped on purpose. This exact row became a template supplies row at Eden.",
      },
      {
        kind: "rule",
        title: "The debrief is finished when the template is better",
        text: "Not when the notes are written. Eden's debrief produced a dozen template improvements: earlier call times, more blankets, fewer plates, a circular stage layout. It's the most-skipped, highest-value hour in the event lifecycle. Protect it.",
      },
      {
        kind: "p",
        text: "Be concrete. \"More blankets, fewer plates\" with counts and costs becomes a template row. \"Food was kinda off\" becomes nothing.",
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
          "Every learning gets dispatched: the row changes the template, informs future teams, or is dropped on purpose.",
      },
      {
        prompt: "When is the debrief done?",
        options: [
          "When the meeting ends",
          "When all rows are written down",
          "When the template is better: every row dispatched",
          "When the event is marked completed",
        ],
        answerIndex: 2,
        explanation:
          "The debrief is a template-editing session. It's finished when the learnings are in the template, not on a page.",
      },
      {
        prompt: "Which debrief row is useful?",
        options: [
          "\"Food was kinda off\"",
          "\"Vibes were good\"",
          "\"8 pizzas fed everyone; we threw out 3. Order 6 next time\"",
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
        text: "Every event page has an assistant that knows the playbook, the guides, and your live plan: statuses, due dates, owners, readiness. Ask it to brief you. It reads the real rows and leads with what matters *now*.",
      },
      {
        kind: "agent_demo",
        exchanges: [
          { who: "you", text: "Brief me on this event." },
          {
            who: "agent",
            text: "We're at T-9, readiness 62%. 3 crew spots are still unconfirmed and your template locks crew at T-10. That's today's fix.",
          },
          {
            who: "agent",
            text: "Also: the sound permit row has no owner, and the run of show isn't locked (due T-3). Want me to assign owners to every unassigned task from its role?",
          },
          { who: "you", text: "Yes, and draft the crew ask for the group chat." },
          {
            who: "agent",
            text: "Done: 6 tasks assigned, one revertible run. The crew ask is drafted. It's public-facing, so nothing sends until you say so.",
          },
        ],
      },
      {
        kind: "p",
        text: "It works in **batches**: it describes the changes, applies them in one revertible run, and summarizes what changed. A wrong batch undoes as a unit, so you can let it work freely on plan internals.",
      },
      {
        kind: "table",
        headers: ["It wants to…", "Who decides"],
        rows: [
          ["Edit rows, statuses, offsets, owners", "**Free hand**: revertible plan internals"],
          ["Delete anything, or mark anything *ready*", "**Asks first**"],
          ["Change the event date or status", "**Asks first**"],
          ["Anything crew- or public-facing (messages, announcements, pages)", "**Asks first**"],
        ],
      },
      {
        kind: "rule",
        title: "The consent line",
        text: "You and the assistant edit the plan together. Anything that reaches other people, or signs your name to a claim, waits for a human's yes.",
      },
      {
        kind: "bullets",
        items: [
          '*"Brief me on my area: what\'s due, what\'s at risk, what\'s unowned?"*',
          '*"We\'re moving to June 14. Reschedule and tell me what becomes infeasible."*',
          '*"Is this event actually ready? Check it against the readiness criteria."*',
          '*"Run my debrief: interview me and draft the rows."*',
        ],
      },
    ],
    quiz: [
      {
        prompt: "Which of these will the assistant do WITHOUT asking first?",
        options: [
          "Send the reminder announcement to crew",
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
          "One proposal, one revertible run, one summary; a wrong batch undoes as a unit",
          "It can only write once per conversation",
          "To hide what it changed",
        ],
        answerIndex: 1,
        explanation:
          "Propose, apply, verify, stay reversible. That's what makes a free hand on plan internals safe.",
      },
      {
        prompt: "Every row is Done, but the assistant won't mark the area ready itself. Why?",
        options: [
          "It can't see the ready flag",
          "Marking ready is a human signing their name to a claim: it will tell you the criteria are met, but the signature is yours",
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
        text: "Most people meet Chapter OS this way: someone else created a big event from a template, and you got handed a role. **Start training** sets up that situation, visible only to you. It's a large worship gathering a month out, mid-planning, with dozens of real rows across every tab. Your role: **Comms Lead**.",
      },
      {
        kind: "rule",
        title: "Nothing here is a mock-up",
        text: "The sandbox is the real product behind a training flag: real tabs, real status chips, the real assistant. It never appears in the chapter's Events tab, dashboards, or reminder emails.",
      },
      {
        kind: "p",
        text: 'Quests are rows in the event itself, prefixed **"Quest:"**. The checklist below ticks as each row reaches its terminal status.',
      },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Take the Comms Lead role**", "Roles before people: put yourself in the role"],
          ["**Find your work in Me view**", "Filter the whole event down to what's yours"],
          ["**Send the announcement**", "Walk a comms row to its terminal state"],
          ["**Post the crew ask**", "Check Crew Duties is written first: areas gate each other"],
          ["**Send the day-before call-time reminder**", "Your message quotes the Run of Show"],
          ["**Swap the Greeter placeholder for a person**", "Fill a placeholder slot from your sample bench"],
          ["**Ask the assistant to brief you on your area**", "Get a briefing from the assistant"],
          ["**Mark the Comms Schedule ready**", "Sign your name to an area, honestly"],
        ],
      },
      {
        kind: "p",
        text: "The Crew list has a couple of **placeholder slots** named for a role (\"Greeter\"). Your bench for filling them is **Maya and Jordan**, sample people. Person pickers in a sandbox only offer *you and sample people*, so you can't pull a real teammate into a drill.",
      },
      {
        kind: "tip",
        text: "The assistant inside the event knows it's a training run. Ask it for help on any quest.",
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
        text: "This time nothing is planned yet. **Start training** creates a nearly empty birthday party sandbox, and you're the event owner. On your team: **Maya and Jordan**, two sample teammates. Put them in roles and hand them real areas of the plan. On your crew: **Uncle Ray** runs the grill and **Cousin Lena** is on decorations. You still need to hire **Sunny the Clown**, a paid professional.",
      },
      {
        kind: "rule",
        title: "Same machine, any event",
        text: "A birthday party uses the same tabs, rows, offsets, crew, and readiness as a worship gathering for two hundred people. Plan this party so it would run without you in the backyard.",
      },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Rename the party + set the date**", "Own the calendar and watch due dates derive"],
          ["**Add three tasks of your own, with timing**", "Build a plan backwards from the date"],
          ["**Give Maya and Jordan each a role**", "Delegate whole areas"],
          ["**Hire Sunny the Clown as paid crew**", "Paid crew: amount, payment status, budget rollup"],
          ["**Send the invites**", "A comms row from draft to sent"],
          ["**Get the cake in hand**", "Walk a supply to Have it and record where it lives"],
          ["**Ask the assistant to poke holes in your plan**", "Use the readiness check before you trust the plan"],
          ["**Log one learning and mark it Actioned**", "Close the loop with the debrief habit"],
        ],
      },
      {
        kind: "tip",
        text: "Uncle Ray and Cousin Lena are already on the Crew list as samples. Check how their team, status, and call time are set up before you add Sunny.",
      },
    ],
    quiz: [],
  },

  // ── 17 · Bonus capstone: worship event ─────────────────────────────────────
  {
    slug: "capstone-worship-event",
    title: "Bonus: plan a worship event",
    subtitle: "Optional: the real thing, from scratch",
    minutes: 12,
    capstone: { kind: "worship_event" },
    optional: true,
    blocks: [
      {
        kind: "p",
        text: "Optional: plan a pop-up worship event from scratch, the kind our chapters run. Public space, amplified sound, a worship leader to confirm, a battery that must be charged.",
      },
      {
        kind: "rule",
        title: "This is the event you'll run",
        text: "Finish this and your first real Worship With Strangers is a repeat, not a first attempt. It doesn't count toward your trained badge.",
      },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Set your date + location**", "The basics: a date and a place"],
          ["**Scout the spot + write the rain plan**", "Write contingencies into the plan"],
          ["**Confirm a worship leader**", "The one person the program depends on"],
          ["**Sort the sound permit**", "Lead-time work on someone else's clock"],
          ["**Build the run of show**", "Load-in, sound check, huddle, worship, strike, one owner each"],
          ["**Announce it**", "The comms moment, gated on your location being locked"],
          ["**Get the battery out, charged**", "Charged, in hand, on the Packing checklist by T-1"],
          ["**Ask the assistant for a readiness briefing**", "The final check before the day"],
          ["**Capture one learning and dispatch it**", "Feed the template so next time is easier"],
        ],
      },
      {
        kind: "tip",
        text: "Keep this sandbox as a reference. When you plan your first real event, open it alongside and copy your own moves.",
      },
    ],
    quiz: [],
  },

  // ── 18 · Capstone: run the comms (Comms Lead) ──────────────────────────────
  {
    slug: "capstone-comms-lead",
    title: "Capstone: run the comms",
    subtitle: "Duties first, then recruit a crew from a real bench",
    minutes: 12,
    capstone: { kind: "comms_lead" },
    blocks: [
      {
        kind: "p",
        text: "**Start training** sets up a worship gathering three weeks out. The comms area is *yours from zero*: no duties written, open crew slots, and an announcement that hasn't gone out. A real Comms Lead walks into exactly this.",
      },
      {
        kind: "rule",
        title: "Duties before people, messages on a schedule",
        text: "Write what each team does BEFORE you recruit anyone into it. Then make sure every audience hears from you in every phase. The quests follow the order you'll use on a real event.",
      },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Take the Comms Lead role**", "Put yourself in the role; the tab's unowned rows become yours"],
          ["**Write the Welcome team's duties**", "The job someone says yes to, written first"],
          ["**Write duties for Prayer and Content**", "Every team someone will join has its expectations in writing"],
          ["**Post the crew ask**", "Now you can recruit against real, written jobs"],
          ["**Fill every open crew slot from your bench**", "Invite people in so placeholders become named people"],
          ["**Chase every invite to Confirmed, with call times**", "Invited is a maybe; only confirmed counts"],
          ["**Send the announcement**", "The public moment, gated on the venue being locked"],
          ["**Send the T-1 call-time reminder**", "Your copy quotes the Run of Show"],
          ["**Mark the Comms Schedule ready**", "Sign your name to the area, honestly"],
        ],
      },
      {
        kind: "p",
        text: "Your recruiting bench is the sandbox's **sample people**: Maya, Jordan, Sam, and Priya. Person pickers in a sandbox only offer you and sample people, so practice freely. In real life this is the text you send a friend. Here, filling the slot stands in for their yes.",
      },
      {
        kind: "tip",
        text: "Stuck on copy? Ask the event's assistant to draft the crew ask or the reminder, then review and send it. That's how the job works outside the sandbox too.",
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
        text: "The Event Lead makes sure the *whole plan* happens. **Start training** hands you a worship gathering three weeks out that's drifting. Something's overdue, something's missing, the run of show is a stub, and a permit hasn't been applied for.",
      },
      {
        kind: "rule",
        title: "Start with the red band",
        text: "An Event Lead reads the plan top-down every day: overdue first, unowned second, missing third. Fix the plan, not the moment.",
      },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Take the Event Lead role**", "The chain now ends at you; unowned rows are yours"],
          ["**Clear the overdue venue walkthrough**", "Triage the red band first, every time"],
          ["**Add the missing task, written for a stranger**", "Details carry the how and the why past the person who knew"],
          ["**Give Maya and Jordan each an area**", "Delegate whole areas, not errands"],
          ["**Build the run of show, one named owner per segment**", "Nobody has to guess who does what on the day"],
          ["**Walk the sound permit to Approved**", "Lead-time work on someone else's clock"],
          ["**Write the rain plan + permit fallback**", "Write contingencies while you're calm"],
          ["**Ask the assistant for the owner's test**", '"If I disappeared today, what breaks?"'],
          ["**Log one learning and dispatch it**", "Close the loop with the debrief habit"],
        ],
      },
      {
        kind: "p",
        text: "Maya and Jordan are sample teammates on your roster. Put them in the Comms and Logistics roles and let the plan resolve work to them. Then run the owner's test: read the plan as if you won't be there, and make every wobble a row.",
      },
      {
        kind: "tip",
        text: "Watch the rings on the event header: the Planning ring's pace check flips from amber to \"✓ on pace\" as you clear the overdue rows.",
      },
    ],
    quiz: [],
  },

  // ── 20 · Capstone: run the supplies (Logistics Lead) ───────────────────────
  {
    slug: "capstone-logistics-lead",
    title: "Capstone: run the supplies",
    subtitle: "Get it, know where it lives, pack it",
    minutes: 10,
    capstone: { kind: "logistics_lead" },
    blocks: [
      {
        kind: "p",
        text: "Every physical thing the event needs: in hand, in a known container, on time. **Start training** creates a worship gathering two weeks out with every classic supply problem. An order must go out *now*, a battery sits in storage with no charger, nobody has bought ice, and the list has gaps.",
      },
      {
        kind: "rule",
        title: "Every item is two jobs on two clocks",
        text: "Getting it is planning work with real-world lead times. Packing it happens day-of, tracked on the Packing checklist. Record WHERE things live, so pack day is a checklist run.",
      },
      {
        kind: "table",
        headers: ["Quest", "The move it drills"],
        rows: [
          ["**Take the Logistics Lead role**", "Unowned items default to you"],
          ["**Order the connect cards before shipping closes**", "Order-online rows carry a lead time; walk it to Have it"],
          ["**Get the battery out, charged**", "The VERY IMPORTANT row: no charger in storage"],
          ["**Buy the ice + record where it lives**", "Have it answers 'do we?'; Source answers 'where?'"],
          ["**Add two missing items with have-it-by timing**", "Complete the list, don't only work through it"],
          ["**Run the packing checklist**", "Packed is a checklist, never a status"],
          ["**Draw the site map**", "Place supplies and crew where they go"],
          ["**Mark Supplies & Logistics ready**", "Sign your name: everything in hand, packed, and placed"],
        ],
      },
      {
        kind: "tip",
        text: "Watch the rings: getting items moves the Planning ring, and packing moves Day-of.",
      },
    ],
    quiz: [],
  },
];

/** The Events stream's theme entry. */
export const EVENTS_THEME: Theme = {
  key: "events",
  title: "Events",
  subtitle: "Plan and run events nobody has to rescue.",
};

/** The Events stream's courses, in catalog order. */
export const EVENTS_COURSES: Course[] = [
  {
    slug: "chapter-os-fundamentals",
    themeKey: "events",
    title: "Chapter OS fundamentals",
    level: "beginner",
    audience: "role",
    description:
      "The conceptual intro everyone needs, plus the two cross-cutting " +
      "product-literacy tabs (Debrief and the assistant) every role uses.",
    icon: "compass",
    moduleSlugs: [
      "what-is-events-os",
      "organizers-and-crew",
      "anatomy-of-an-event",
      "timing-and-offsets",
      "phase-rings",
      "tab-debrief",
      "using-the-assistant",
    ],
  },
  {
    slug: "comms-lead",
    themeKey: "events",
    title: "Comms Lead",
    level: "intermediate",
    audience: "role",
    description:
      "The Comms Lead's remit at Public Worship: crew coordination and comms, " +
      "capped by a hands-on capstone: write the duties, recruit the crew.",
    icon: "message-circle",
    moduleSlugs: ["tab-crew-duties", "tab-comms", "capstone-comms-lead"],
  },
  {
    slug: "event-lead",
    themeKey: "events",
    title: "Event Lead",
    level: "intermediate",
    audience: "role",
    description:
      "The Event Lead's remit: tasks, run of show, and permitting, then a " +
      "capstone where you rescue a drifting plan.",
    icon: "clipboard",
    moduleSlugs: [
      "tab-tasks",
      "tab-run-of-show",
      "tab-permits",
      "capstone-event-lead",
    ],
  },
  {
    slug: "logistics-lead",
    themeKey: "events",
    title: "Logistics Lead",
    level: "intermediate",
    audience: "role",
    description:
      "The Logistics Lead's remit: supplies & logistics and the chapter " +
      "gear registry, capped by a hands-on capstone.",
    icon: "package",
    moduleSlugs: ["tab-supplies", "keeping-inventory", "capstone-logistics-lead"],
  },
  {
    slug: "owning-an-event",
    themeKey: "events",
    title: "Owning an event",
    level: "advanced",
    audience: "ownership",
    description:
      "Accountability doctrine and the hands-on capstones. The worship capstone " +
      "is an optional bonus and does not gate the course badge.",
    icon: "key",
    moduleSlugs: [
      "being-an-owner",
      "capstone-join-an-event",
      "capstone-birthday-party",
      "capstone-worship-event",
    ],
  },
];
