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
