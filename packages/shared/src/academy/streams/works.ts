/**
 * The Works stream — projects & duties, the chapter's ongoing work between
 * events. Also the Works theme + its two courses.
 *
 * Owned exclusively by this file for content authoring — do not add Works
 * sections or courses anywhere else. See `../index` for how this assembles
 * into the full curriculum/catalog.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Works-stream sections, in curriculum order. */
export const WORKS_SECTIONS: Omit<AcademySection, "order">[] = [
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

  // ── 25 · Works: leading a project — defining it ─────────────────────────────
  {
    slug: "works-defining-a-project",
    title: "Defining the project",
    subtitle: "What it is, what done looks like, and who's allowed to lead it",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "You already know the shape of a project from the last course: finite work, one owner, a finish line. Leading one is a different job than owning a task inside one — this course is about being the person who makes sure the whole thing lands, on time, at the standard Public Worship holds itself to.",
      },
      {
        kind: "rule",
        title: "Not about doing everything — about ensuring everything gets done",
        text: "A Project Lead's job isn't to personally execute every row. It's to own the timeline and the communication, pull in whoever the project actually needs from any team, and make sure the finished thing meets the standard — the same doctrine as owning an event, one layer up.",
      },
      { kind: "heading", text: "Anyone can lead a project" },
      {
        kind: "p",
        text: "Seniority isn't a requirement — a team Director can lead a project, and so can someone who just joined. What actually qualifies you is willingness to own the outcome and see it through, not tenure or title. If you're the one who cares enough to make it happen, it's yours to lead.",
      },
      { kind: "heading", text: "Writing the definition of done" },
      {
        kind: "p",
        text: "A project's purpose line answers \"why does this exist.\" Its **definition of done** answers something narrower and more useful: \"how will anyone — including you — know it's actually finished?\" Skip this and every conversation about scope becomes an argument nobody can win, because nobody agreed what winning looks like.",
      },
      {
        kind: "table",
        headers: ["Sounds like a definition of done", "Is actually one"],
        rows: [
          [
            "\"Redesign the welcome cards\"",
            "\"New welcome card design approved by the Marketing Director, printed, and in every chapter's greeter kit by [date]\"",
          ],
          [
            "\"Get the giving page live\"",
            "\"Giving page accepts a real donation, is linked from the app's home tab, and the Treasurer has confirmed it reconciles\"",
          ],
          [
            "\"Find a winter venue\"",
            "\"Signed contract on file for a venue that fits capacity and budget, for [dates]\"",
          ],
        ],
      },
      {
        kind: "rule",
        title: "A definition of done ends the argument before it starts",
        text: "Write it specific enough that two different people would agree, independently, on whether it happened. If it needs a judgment call to know you're finished, it isn't a definition of done yet — it's still a vibe.",
      },
      {
        kind: "reveal",
        prompt:
          "You're asked to \"own onboarding for new members.\" What's your first move as Project Lead?",
        answer:
          "Before you assign a single task, write what done actually looks like — e.g., \"every new member gets a welcome message within 24 hours and completes the Foundations trio within their first month.\" Without that, you can run onboarding forever and never know if you're succeeding.",
      },
      {
        kind: "link",
        label: "Further reading: Atlassian — What is a Definition of Done?",
        url: "https://www.atlassian.com/agile/project-management/definition-of-done",
      },
    ],
    quiz: [
      {
        prompt:
          "A first-week volunteer wants to lead the flyer redesign project. Per this lesson, what's the issue?",
        options: [
          "They need a team Director's sign-off first",
          "New members can only lead projects under $50",
          "There isn't one — anyone willing to own the outcome can lead a project",
          "They should wait a year before leading anything",
        ],
        answerIndex: 2,
        explanation:
          "Seniority isn't the qualifier — ownership is. A Project Lead can be a Director or someone who just joined.",
      },
      {
        prompt: "What does a Project Lead actually own, according to this lesson?",
        options: [
          "Personally doing every task on the project",
          "The timeline, the communication, and the standard the finished thing has to meet — not every row themselves",
          "Nothing until the deadline",
          "Only the budget line",
        ],
        answerIndex: 1,
        explanation:
          "It's the same distinction Foundations teaches: ensuring everything gets done, not doing everything yourself.",
      },
      {
        prompt:
          "Why does a project need a written definition of done, not just a purpose line?",
        options: [
          "It's a formality nobody actually checks",
          "Purpose and definition of done are the same thing",
          "Only budgeted projects need one",
          "A purpose line says why it exists; a definition of done says exactly how anyone would know it's finished — specific enough two people would agree independently",
        ],
        answerIndex: 3,
        explanation:
          "Skip the definition of done and scope arguments become unwinnable — nobody agreed what \"finished\" meant.",
      },
      {
        prompt: "Which of these is an actual definition of done?",
        options: [
          "\"Make the giving page good\"",
          "\"Giving page accepts a real donation, is linked from the home tab, and the Treasurer has confirmed it reconciles\"",
          "\"Get people excited about giving\"",
          "\"Work on the giving page this quarter\"",
        ],
        answerIndex: 1,
        explanation:
          "Specific and checkable — two different people could independently verify every clause of it.",
      },
    ],
  },

  // ── 26 · Works: leading a project — planning the work ───────────────────────
  {
    slug: "works-planning-the-work",
    title: "Planning the work",
    subtitle: "Breaking it down, owning every piece, and pulling people across teams",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A definition of done tells you where you're going. Planning is turning that into rows a team can actually pick up — broken down small enough that each one has a single, clear owner.",
      },
      { kind: "heading", text: "Every task needs the same three things" },
      {
        kind: "p",
        text: "This is the same triad Public Worship asks of any commitment, project or not: an owner, a deadline, and a definition of done. A task missing any of the three isn't actually assigned yet, no matter how clearly you described it in the group chat.",
      },
      {
        kind: "bullets",
        items: [
          "**Owner** — one name, not \"the Music team.\" A task two people co-own is a task nobody owns.",
          "**Deadline** — not \"soon.\" A real date, one someone can miss and you'd notice.",
          "**Definition of done** — what finished looks like for THIS task, not just the project overall.",
        ],
      },
      {
        kind: "rule",
        title: "If any of the three is missing, it isn't a real commitment yet",
        text: "Pin down owner, deadline, and definition of done before you call a task assigned — the same bar \"Owning your yes\" sets for any commitment at Public Worship.",
      },
      { kind: "heading", text: "Deadlines need real lead time, not wishful thinking" },
      {
        kind: "p",
        text: "Work backward from the finish line, not forward from today. Printing takes 3 days. A vendor contract needs a week for signatures. Ask what each step actually requires before you promise a date, or your plan is a wish wearing a calendar.",
      },
      { kind: "heading", text: "Projects pull from any team, on purpose" },
      {
        kind: "p",
        text: "Projects are built to cross teams — that's not a workaround, it's the design. A Project Lead can ask anyone for help with a task the project genuinely needs, regardless of which team's channel they usually sit in.",
      },
      {
        kind: "tree",
        caption:
          "You're pulled onto another team's project — your own team stays looped in, not routed around.",
        nodes: [
          { label: "Fall Flyer Campaign — Project Lead (Marketing)", depth: 0 },
          { label: "You — pulled in for social copy", depth: 1, highlight: "self" },
          { label: "Your manager — Music Lead, kept in the loop", depth: 1, highlight: "manager" },
        ],
      },
      {
        kind: "rule",
        title: "Loop in the manager, don't route around them",
        text: "Pulling someone across teams works because it's out in the open. Tell the person's own manager what you need and for how long — the same beat as raising a scope change early: silence protects nobody, a heads-up protects everyone's time.",
      },
      {
        kind: "reveal",
        prompt:
          "You need someone from the Music team for two afternoons of video editing help. What do you do before you message them?",
        answer:
          "Tell their manager (the Music Lead) what you need and roughly how long it'll take, so it isn't a surprise when it shows up at their next 1:1. Then make the ask directly — projects are built to cross teams, but the person's home team should never be blindsided by where their week went.",
      },
      {
        kind: "link",
        label: "Further reading: Basecamp — Shape Up (breaking work into real bets)",
        url: "https://basecamp.com/shapeup",
      },
    ],
    quiz: [
      {
        prompt:
          "What three things does every task in a project plan need, echoing the same rule as any commitment at Public Worship?",
        options: [
          "A budget, a name, and a channel",
          "A priority level, a color, and a tag",
          "An owner, a deadline, and a definition of done",
          "A Director's approval, always",
        ],
        answerIndex: 2,
        explanation:
          "Same triad as \"Owning your yes\" — miss any of the three and the task isn't actually assigned yet.",
      },
      {
        prompt: "Two people are both loosely responsible for the same task. What's wrong with that?",
        options: [
          "A task with two owners is a task nobody actually owns",
          "Nothing — more hands means it gets done faster",
          "It's fine as long as one of them is a Director",
          "Co-ownership is required for tasks over a week long",
        ],
        answerIndex: 0,
        explanation:
          "Owner means one name. Shared ownership quietly becomes no ownership the moment things get busy.",
      },
      {
        prompt: "Why work backward from the deadline instead of forward from today when scheduling a task?",
        options: [
          "Forward planning is always faster",
          "Only vendors need lead-time math",
          "It doesn't matter which direction you plan from",
          "Real steps — printing, contracts, approvals — take actual lead time; working backward is what keeps the date honest",
        ],
        answerIndex: 3,
        explanation:
          "A deadline set without accounting for real lead times is a wish wearing a calendar, not a plan.",
      },
      {
        prompt:
          "You're on the Music team and a Project Lead from Marketing asks you to help with social copy. What should already have happened?",
        options: [
          "Nothing — they should have asked your Music Lead's permission before ever talking to you",
          "You should refuse — it's not your team's project",
          "The Project Lead told your manager what they need and roughly how long, so it isn't a surprise at your next 1:1",
          "Only Directors can be asked to help outside their team",
        ],
        answerIndex: 2,
        explanation:
          "Projects are built to cross teams on purpose — the ask is yours to say yes to. What protects everyone is the Project Lead looping your manager in early, not asking permission instead of you.",
      },
    ],
  },

  // ── 27 · Works: leading a project — the budget ──────────────────────────────
  {
    slug: "works-the-project-budget",
    title: "Building the budget",
    subtitle: "Draft, send for review, approved — and what a raise actually does",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A project doesn't automatically get a budget — plenty of projects are pure work-tracking, no dollars involved. A budget only exists once real money enters the picture: enter a planned amount when you create the project and a Draft budget is created right then, or tap **Add budget** on the project's own page later, once there's actually something to plan. Either way, nothing is approved until someone deliberately moves it forward.",
      },
      { kind: "heading", text: "The plan lives as line items" },
      {
        kind: "p",
        text: "Build the plan the same way you built the task list: real numbers against real things — venue, vendor, print run — not one lump sum. Line items are what let anyone, including your approver, see what they're actually saying yes to.",
      },
      { kind: "heading", text: "Draft → Send for review → Approved" },
      {
        kind: "bullets",
        items: [
          "**Draft** — yours to edit freely. Nobody outside your own head has weighed in, and nothing you type here spends anything.",
          "**Send for review** — a deliberate tap. The moment you send it, the budget is Awaiting approval and visible to whoever can act on it.",
          "**Approve or Request changes** — the approver clears it, or kicks it back with a reason, which reopens it for editing and a fresh send.",
        ],
      },
      {
        kind: "table",
        headers: ["Scope", "Who approves it"],
        rows: [
          ["Chapter project", "Treasurer or Chapter Director"],
          ["Central project", "Executive Director or Financial Manager"],
        ],
      },
      {
        kind: "rule",
        title: "Approver ≠ you, always",
        text: "Whoever sends a budget for review can never be the one who approves it — the same separation of duties that governs every other budget in the app, chapter or central.",
      },
      {
        kind: "rule",
        title: "Raising the cap sends it back to Draft — but nobody's told",
        text: "Bump an APPROVED budget's amount and it drops straight back to Draft the moment you save — not Awaiting approval, and not auto-submitted. The OLD approved figure keeps working as the real spending cap the whole time, so nothing silently expands. But the increase itself is invisible to every approver until YOU deliberately hit Send for review again. Skip that tap and the raise is never reviewed.",
      },
      {
        kind: "p",
        text: "Spending against an approved budget — using the Public Worship card, closing the receipt loop within the 7-day window — works exactly like it does everywhere else in the app. \"Finances for Everyone\" covers the mechanics; nothing about being a Project Lead changes them.",
      },
      {
        kind: "scenario",
        prompt:
          "A vendor quote for stage rental comes in 40% over your project's approved budget line. What do you do?",
        options: [
          {
            text: "Book it anyway — the event's close, there's no time to wait",
            feedback:
              "Spending past the approved cap doesn't get quietly waved through — it raises a loud warning on the budget, and it puts you in the position of explaining an overrun after the fact instead of a raise before it.",
          },
          {
            text: "Find the difference by quietly padding another line so the total looks unchanged",
            feedback:
              "That's not a plan, it's a hope that nobody checks the math. Line items exist so an approver can see what they're actually saying yes to — moving numbers around to hide a real cost defeats the point of the plan.",
          },
          {
            text: "Raise it now: adjust the plan to fit the approved cap, or bump the line and immediately re-send the budget for review",
            correct: true,
            feedback:
              "Right — the old approved amount is still the real cap until someone acts, so surface the gap the moment you know about it. Either descope to fit what's approved, or raise the amount and hit Send for review yourself; skip that tap and the increase is never reviewed.",
          },
          {
            text: "Wait a week to see if the vendor's price comes down before deciding anything",
            feedback:
              "Waiting doesn't shrink the gap between the quote and your cap — it just shrinks how much runway you have to fix it. Raise it the moment you know, the same as any other blocker.",
          },
        ],
      },
      {
        kind: "tip",
        text: "In the app: raising a budget's amount is a save, not an approval. The tap that actually matters — the one that gets it in front of your Treasurer or Chapter Director — is Send for review. Do both in the same sitting.",
      },
    ],
    quiz: [
      {
        prompt:
          "A project is created with a name, an owner, and a deadline — no dollar amount entered. What's true about its budget right now?",
        options: [
          "It's sitting in Draft at $0, waiting for someone to send it for review",
          "There's no budget row at all yet — most projects are work-tracking only; one appears once you enter a real amount or tap Add budget",
          "It's Approved automatically at $0",
          "It's Awaiting approval, pending the Treasurer",
        ],
        answerIndex: 1,
        explanation:
          "A budget only exists once real money enters the picture. No amount at creation means no budget row yet — not a hidden Draft one.",
      },
      {
        prompt: "Who approves a chapter project's budget?",
        options: [
          "Only the Executive Director",
          "Whoever submitted it, if they hold a finance seat",
          "Central approves every chapter budget",
          "The Treasurer or Chapter Director",
        ],
        answerIndex: 3,
        explanation:
          "Chapter-scope budgets are approved by the Treasurer or Chapter Director; central-scope by the ED or Financial Manager — never by whoever sent it.",
      },
      {
        prompt:
          "You raise an APPROVED project budget from $1,000 to $1,400 and don't re-send it for review. What's the live spending cap right now?",
        options: [
          "$1,400 — available immediately",
          "Whatever the last transaction used",
          "$1,000 — the old approved amount, until you send the raise for review and it's approved",
          "$0 — spending is frozen until the raise clears",
        ],
        answerIndex: 2,
        explanation:
          "The increase flips the budget back to Draft, not Awaiting approval — the OLD approved figure keeps enforcing the cap until you deliberately resend it and someone approves the new amount.",
      },
      {
        prompt: "A vendor quote comes in over your approved budget line. What's the wrong move?",
        options: [
          "Descope the plan to fit what's approved",
          "Flag it to your approver the same day you find out",
          "Spend past the cap and explain it after the fact",
          "Raise the line and immediately send it for review",
        ],
        answerIndex: 2,
        explanation:
          "Never just spend past an approved cap. Raise the gap early — adjust the plan or resend the raised budget — the same way you'd escalate any other blocker.",
      },
    ],
  },

  // ── 28 · Works: leading a project — tracking and escalating ────────────────
  {
    slug: "works-tracking-and-escalating",
    title: "Tracking execution, escalating risks",
    subtitle: "Checkpoints, outcomes over tasks, and closing the loop with your Director",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "You're not doing every task, so tracking a project means watching everyone else's slice of it — not just logging your own progress. The project's comment thread is still the progression record; as Project Lead, you're the one making sure it stays true for the whole thing, not just your own rows.",
      },
      { kind: "heading", text: "Checkpoints, not surprises" },
      {
        kind: "p",
        text: "Set a rhythm for checking in on the pieces you didn't personally touch — a weekly pass through the task list is enough for most projects. The goal isn't policing; it's catching a slipping piece while there's still time to do something about it.",
      },
      {
        kind: "rule",
        title: "Outcomes, not tasks",
        text: "Your job is the finished thing, not a checklist of completed rows. A task getting marked done that doesn't actually move the project toward its definition of done is theater — track whether the OUTCOME is on track, not just whether boxes are checked.",
      },
      { kind: "heading", text: "\"Someone dropped out\" is not an excuse" },
      {
        kind: "p",
        text: "People get sick, get busy, or take on more than they can carry — that's normal, not a scandal. What isn't acceptable is a task quietly going dark because the person attached to it went dark. The plan has to survive people being people; that's your job to build in, not theirs to apologize for.",
      },
      {
        kind: "bullets",
        items: [
          "**Notice fast.** A checkpoint exists so a stalled task surfaces in days, not at the deadline.",
          "**Raise it directly first.** Ask the person what's actually happening before you assume the worst or route around them.",
          "**Don't silently absorb it.** Taking over their task yourself hides the real problem — the project's staffing — behind your own overtime.",
        ],
      },
      {
        kind: "scenario",
        prompt:
          "A teammate pulled in from another team goes quiet on their task three days before the deadline. What's the right move?",
        options: [
          {
            text: "Quietly finish the task yourself so the project isn't at risk",
            feedback:
              "That solves this task and hides the real problem — you'll be doing this again next time, and nobody who could actually fix the staffing gap even knows it exists.",
          },
          {
            text: "Message them directly today; if you don't hear back same-day, loop in their manager and yours early",
            correct: true,
            feedback:
              "Right — raise it to the person first, then escalate to the managers on both sides while there's still time to react. Early is a conversation; the deadline is a crisis.",
          },
          {
            text: "Wait until the deadline passes, then explain what happened",
            feedback:
              "Waiting doesn't create options — it removes them. The moment you notice a task's gone quiet is the moment to act, not the moment after it's already too late to matter.",
          },
          {
            text: "Remove them from the project without talking to them first",
            feedback:
              "You don't know what's actually happening yet. Ask directly before you assume — going straight to removal skips the conversation that might resolve this in five minutes.",
          },
        ],
      },
      {
        kind: "rule",
        title: "Escalate early, with a proposed path",
        text: "When a risk is real, tell your Director — before the deadline, not after. Bring what's stuck and what you think should happen next: descope, extend, or pull in more help. A blocker with a proposed path is a decision your Director can make in a minute; a blocker with no path is a problem they have to solve from scratch.",
      },
      {
        kind: "p",
        text: "Closing the loop matters as much as raising the flag: once your Director weighs in, tell whoever's affected what changed and why. An escalation that goes quiet after the decision is as bad as one that never got made.",
      },
      {
        kind: "link",
        label: "Further reading: Andon — the manufacturing practice of stopping the line the moment something's wrong",
        url: "https://en.wikipedia.org/wiki/Andon_(manufacturing)",
      },
    ],
    quiz: [
      {
        prompt: "As Project Lead, what does tracking the project actually mean?",
        options: [
          "Logging only your own tasks",
          "Re-doing tasks yourself to make sure they're right",
          "Watching every piece of the project, including the tasks other people own, for what's slipping",
          "Waiting for people to report problems on their own",
        ],
        answerIndex: 2,
        explanation:
          "You're not doing every task, so tracking means watching everyone's slice — that's the job a Project Lead actually does.",
      },
      {
        prompt: "Why does this lesson say to track outcomes, not tasks?",
        options: [
          "Outcomes are easier to measure than tasks",
          "A checked-off task that doesn't actually move the project toward its definition of done is theater — the real measure is whether the outcome is on track",
          "Tasks don't matter at all",
          "Only the final task in a project counts",
        ],
        answerIndex: 1,
        explanation:
          "A full checklist with a missed outcome isn't success. Track whether the project is actually getting where it needs to go.",
      },
      {
        prompt:
          "A task's owner goes quiet before the deadline. What does \"'someone dropped out' is not an excuse\" mean here?",
        options: [
          "The person is always at fault",
          "The deadline moves automatically when someone drops out",
          "A stalled task can't be blamed away — the plan has to survive people being people, and it's the Project Lead's job to catch it and adapt, not just note the excuse",
          "Projects should never rely on more than one person",
        ],
        answerIndex: 2,
        explanation:
          "People get overloaded — that's normal. What isn't acceptable is the task going dark unnoticed. Catching it and adapting the plan is the Project Lead's job.",
      },
      {
        prompt: "What makes an escalation to your Director useful rather than just a complaint?",
        options: [
          "Waiting until you're certain nothing can be done before saying anything",
          "Escalating as loudly and publicly as possible",
          "Escalating only after the deadline has already passed",
          "Bringing what's stuck AND a proposed path — descope, extend, or pull in help — so it's a decision your Director can make quickly",
        ],
        answerIndex: 3,
        explanation:
          "A blocker with a proposed path is a decision; a blocker with no path is a problem your Director has to solve from scratch. Early plus a path is what makes escalation work.",
      },
    ],
  },

  // ── 29 · Works: leading a project — finishing well ──────────────────────────
  {
    slug: "works-finishing-well",
    title: "Completing and reviewing",
    subtitle: "The debrief, closing the money, and celebrating the people",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Marking a project Done is the easy part. Finishing it well means the next project inherits something real from this one — not just a green checkmark nobody learns from.",
      },
      { kind: "heading", text: "The debrief" },
      {
        kind: "p",
        text: "Before you close it out, get the people who carried the project in a room (or a thread) and ask three questions: what worked, what didn't, and what should the next Project Lead know before they start. Write the answers down where the next person will actually find them — a debrief nobody reads is just a meeting.",
      },
      {
        kind: "rule",
        title: "Learnings go in the written source immediately",
        text: "The same reflex duties use for their runbooks: the moment you learn something worth knowing, it goes in the doc, not in your memory. A debrief that stays a conversation dies with the people who were in the room.",
      },
      { kind: "heading", text: "Close the loose financial ends" },
      {
        kind: "p",
        text: "Before you call the project done, make sure the budget matches reality: every charge attributed, every receipt closed, and the budget itself reflects what actually got spent — not what was originally planned. A project marked Done with an open budget just becomes someone else's cleanup.",
      },
      {
        kind: "bullets",
        items: [
          "**Reconcile the last charges.** Nothing should be sitting unattributed once the project wraps.",
          "**True up the amount.** If you underspent or overspent the approved cap, the record should say so honestly — that's data the next Project Lead needs.",
          "**Hand off, don't abandon.** If anything's still open — a reimbursement, a pending invoice — name it explicitly so it doesn't fall through the cracks.",
        ],
      },
      { kind: "heading", text: "Celebrate the people" },
      {
        kind: "p",
        text: "A project that pulled people across three teams for six weeks deserves more than a status change. Say thank you specifically — what someone actually did, not a group \"great job everyone\" — to the people who showed up for a project that wasn't even their normal team's work.",
      },
      {
        kind: "reveal",
        prompt: "The giving page project just shipped. What's left before you mark it Done and move on?",
        answer:
          "Run the debrief (what worked, what didn't, what the next lead should know — written down), reconcile the budget so nothing's left unattributed, and thank the specific people who helped — including anyone pulled in from another team. Done with none of that is done only for you.",
      },
      {
        kind: "link",
        label: "Further reading: Atlassian — how to run an effective project retrospective",
        url: "https://www.atlassian.com/team-playbook/plays/retrospective",
      },
    ],
    quiz: [
      {
        prompt: "Why does this lesson say a debrief nobody reads \"is just a meeting\"?",
        options: [
          "Meetings are inherently useless",
          "Learnings only help the next project if they're written where the next Project Lead will actually find them — a spoken debrief dies with the people in the room",
          "Debriefs should never be written down",
          "Only Directors need to read debriefs",
        ],
        answerIndex: 1,
        explanation:
          "Same reflex as duty runbooks: write it down immediately, or the learning doesn't survive past the people who were there.",
      },
      {
        prompt: "What does \"closing the loose financial ends\" require before a project is really done?",
        options: [
          "Financial cleanup is the Treasurer's job, never the Project Lead's",
          "Only the approved amount needs to be correct, not actual spend",
          "Every charge reconciled and attributed, and the budget trued up to reflect what actually got spent",
          "Nothing — the budget can stay open indefinitely",
        ],
        answerIndex: 2,
        explanation:
          "A project marked Done with an open budget just becomes someone else's cleanup — reconcile and true up the numbers before you close it out.",
      },
      {
        prompt: "What's the better way to thank the people who helped on a project?",
        options: [
          "Thanking only the people from your own team",
          "Waiting until the next project to mention it",
          "A single group message: \"great job everyone\"",
          "Specific thanks naming what each person actually did — especially anyone pulled in from another team",
        ],
        answerIndex: 3,
        explanation:
          "Specific beats generic — especially for people who gave time to a project that wasn't even their normal team's work.",
      },
    ],
  },
];

/** The Works stream's theme entry. */
export const WORKS_THEME: Theme = {
  key: "works",
  title: "Works",
  subtitle: "Projects & duties — the chapter's ongoing work between events.",
};

/** The Works stream's courses, in catalog order. */
export const WORKS_COURSES: Course[] = [
  {
    slug: "projects",
    themeKey: "works",
    title: "Projects",
    level: "beginner",
    audience: "team",
    description:
      "Finite work with one owner and a finish line: purpose, status, " +
      "deadline, blockers, and driving it to done.",
    icon: "briefcase",
    moduleSlugs: ["works-projects", "works-driving-a-project"],
  },
  {
    slug: "leading-a-project",
    themeKey: "works",
    title: "Leading a project",
    level: "intermediate",
    audience: "role",
    description:
      "The whole arc of running a project: defining it and its finish " +
      "line, planning the work and pulling people across teams, building " +
      "and raising the budget, tracking execution and escalating risk, " +
      "and finishing well.",
    icon: "target",
    moduleSlugs: [
      "works-defining-a-project",
      "works-planning-the-work",
      "works-the-project-budget",
      "works-tracking-and-escalating",
      "works-finishing-well",
    ],
  },
  {
    slug: "duties",
    themeKey: "works",
    title: "Duties",
    level: "beginner",
    audience: "team",
    description:
      "The work that never finishes: cadences, fan-out to roles, runbooks, " +
      "and handoffs that don't need a meeting.",
    icon: "repeat",
    moduleSlugs: ["works-duties", "works-owning-a-duty"],
  },
];
