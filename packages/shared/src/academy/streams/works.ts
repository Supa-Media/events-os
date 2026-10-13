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
        text: "Not everything the chapter does is an event. Redesigning the welcome cards, setting up the giving page, or finding a winter venue is a **project**: work the team drives outside events, or wrapped around them. Projects live on the **Work** tab, next to Duties.",
      },
      {
        kind: "table",
        headers: ["A project carries", "Why it's there"],
        rows: [
          ["**Purpose**", "What done looks like, so scope arguments end early"],
          ["**One owner**", "The one person accountable for the outcome"],
          ["**Status**", "Not started, In progress, **Blocked**, or Done"],
          ["**Deadline**", "The finish line. Without one, nothing makes the project urgent"],
          ["**Blocker**", "When it's stuck: what's stuck, written where the manager can see it"],
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
          "Blocked is loud on purpose: it asks for help. A project quietly stuck at In progress is the one that never finishes.",
      },
      {
        kind: "rule",
        title: "Readable without a meeting",
        text: "Anyone, including your manager, should be able to see the state of every project without a call: status, deadline, blocker, next step.",
      },
      {
        kind: "p",
        text: "Split a big project into **sub-projects**, each with its own owner and deadline, rolling up to the parent. If a project is really an event's prep, put that work *in the event*. Projects wrap events; they don't duplicate them.",
      },
      {
        kind: "reveal",
        prompt:
          'Someone says "I\'m working on the merch thing." Where should that sentence live?',
        answer:
          "As a project with a name, a purpose line, an owner (them), a status, and a deadline. Then others can see it, help with it, and hold them to it.",
      },
    ],
    quiz: [
      {
        prompt: "What makes something a project rather than an event or a task?",
        options: [
          "It costs money",
          "It's finite team work with an owner and a finish line, outside (or wrapping) an event",
          "It takes more than a week",
          "Only admins can create projects",
        ],
        answerIndex: 1,
        explanation:
          "Projects are the chapter's finite non-event work. Recurring work is a duty, dated gatherings are events, and single to-dos inside an event are that event's rows.",
      },
      {
        prompt: "Why is Blocked its own status instead of a note somewhere?",
        options: [
          "To punish the owner",
          "A blocked project needs to be visible: the blocker is written where the manager can see it and act without a meeting",
          "Because the app can't store notes",
          "Blocked projects are deleted after a week",
        ],
        answerIndex: 1,
        explanation:
          "Blocked asks for help. The quiet failure is a project sitting at In progress while nothing moves. Naming the blocker in the open gets it cleared.",
      },
      {
        prompt: "What's wrong with a project that has no deadline?",
        options: [
          "Nothing, some work is open-ended",
          "It can't have sub-projects",
          "Nothing surfaces it or makes it urgent, so it loses to everything that has a date",
          "The app rejects it",
        ],
        answerIndex: 2,
        explanation:
          "Finite work needs a finish line. Work that never finishes is a duty, not a project.",
      },
      {
        prompt: "Your manager wants to know how the giving-page project is going. What should already be true?",
        options: [
          "You have a meeting scheduled to walk them through it",
          "The project row already answers it: status, deadline, and blocker if stuck",
          "They should ask the assistant to email you",
          "Projects are private to their owner",
        ],
        answerIndex: 1,
        explanation:
          "A manager should see the state of everything their team drives without meeting the owner. Keeping the row current is the report.",
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
        text: "Owning a project means moving it, logging it, and flagging what's stuck. The project's **comment thread is the progression record**. Each update says what moved and what's next, so anyone can pick up the history.",
      },
      {
        kind: "bullets",
        items: [
          "**Update when something happens, not on a schedule.** A decision, a delivery, or a dead end goes in the thread that day.",
          '**Write for the next owner.** "Called the print shop, 3-day turnaround, files due Friday" is useful; "made progress" isn\'t.',
          "**Name who unblocks it.** A blocker without a name is a complaint, not an escalation.",
        ],
      },
      {
        kind: "rule",
        title: "Escalate early",
        text: "Blocked early is a conversation; blocked at the deadline is a crisis. When you know you're stuck or the date will slip, flip the status and write the blocker. Your manager should find out from the app, not from a missed deadline.",
      },
      {
        kind: "p",
        text: "Project reminder emails carry **action links**: mark the project done or flag it blocked from the email, no login required.",
      },
      {
        kind: "reveal",
        prompt:
          "Your project's deadline is Friday and the vendor just went quiet. It's Tuesday. What do you do?",
        answer:
          "Flip it to Blocked today and name the blocker (\"vendor unresponsive since Monday, need a decision: wait or switch\"). Put what you need in the thread. On Tuesday you still have options; on Friday you only have an apology.",
      },
      {
        kind: "tip",
        text: "Finished? Mark it Done and write the last comment as a handoff: what shipped, where it lives, and what the next person needs.",
      },
    ],
    quiz: [
      {
        prompt: "What is the project comment thread for?",
        options: [
          "Congratulating the owner",
          "It's the progression record: what moved and what's next, written so anyone could pick the project up",
          "Legal compliance",
          "It's where the deadline is stored",
        ],
        answerIndex: 1,
        explanation:
          "Updates written for the next owner let anyone hand off or review the project without a meeting.",
      },
      {
        prompt: "You realize on Tuesday the Friday deadline will slip. What's the right move?",
        options: [
          "Work harder and hope",
          "Wait until Friday to be sure, then explain",
          "Flip to Blocked or flag the slip now, and name what's stuck and who can unblock it",
          "Quietly move the deadline",
        ],
        answerIndex: 2,
        explanation:
          "Blocked early is a conversation; blocked at the deadline is a crisis. An early warning keeps options open (wait, switch, re-scope) that vanish at the deadline.",
      },
      {
        prompt: "What makes a blocker entry useful?",
        options: [
          "It's long and detailed about how frustrating things are",
          "It names what's stuck and who or what unblocks it",
          "It's marked urgent",
          "It tags the whole team",
        ],
        answerIndex: 1,
        explanation:
          "A blocker without a name is a complaint. \"Waiting on venue contract, need Jordan's signature\" is an escalation someone can act on.",
      },
    ],
  },

  // ── 23 · Works: duties ──────────────────────────────────────────────────────
  {
    slug: "works-duties",
    title: "Duties",
    subtitle: "Recurring work, on a cadence, assigned to a role",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "Some work has no finish line: making event flyers, meeting with your directs, reconciling giving. That's a **duty**: ongoing, recurring work. Projects finish; duties *recur*. Both live on the Work tab.",
      },
      {
        kind: "table",
        headers: ["A duty carries", "What it means"],
        rows: [
          ["**Cadence**", "Daily, weekly, biweekly, monthly, quarterly, yearly, or ad hoc"],
          ["**Who it fans out to**", "Roles (\"every Director\"), specific people, or both"],
          ["**A runbook**", "The how-to doc for doing the duty"],
        ],
      },
      {
        kind: "p",
        text: "Assign a duty to a **role** and it lands on everyone holding that role. \"Meet with directs, weekly\" reaches every manager automatically, including ones who join next year. Assign to a person only when the duty is theirs alone.",
      },
      {
        kind: "rule",
        title: "If it recurs, it's a duty, not a memory",
        text: "Recurring work kept in someone's head gets done only while that person remembers and stays. Written as a duty with a cadence, it survives vacations, handoffs, and growth.",
      },
      {
        kind: "reveal",
        prompt:
          '"Every month someone should check the storage unit and restock." Project, duty, or task?',
        answer:
          "A duty: it recurs monthly and belongs to a role, not one person. Write it, set the cadence, and assign it to the Logistics role.",
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
          "Finite or recurring is the whole split. A finish line makes it a project; a cadence makes it a duty.",
      },
      {
        prompt: 'A duty is assigned to the "Director" role. A new director joins next month. What happens?',
        options: [
          "Someone must remember to assign them the duty",
          "The duty applies to them automatically, because it lands on everyone holding the role",
          "The duty resets its cadence",
          "New people can't hold duties for 90 days",
        ],
        answerIndex: 1,
        explanation:
          "Duties assigned to a role follow the role. Assign to a specific person only when the duty is theirs alone.",
      },
      {
        prompt: "Why does cadence matter on a duty?",
        options: [
          "It sets how often the duty comes up in reviews and reminders, so a quarterly duty doesn't nag weekly and a weekly one doesn't hide for a month",
          "It changes who owns the duty",
          "It's just a label",
          "Cadence controls the budget",
        ],
        answerIndex: 0,
        explanation:
          "The cadence sets when the duty is due for attention in reminders and 1:1 reviews, so it comes up at its own rhythm.",
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
        text: "Holding a duty means two promises: the work happens *on its cadence*, and how it's done is *written down*. People skip the second, and it's the one that lets someone else keep the first.",
      },
      {
        kind: "rule",
        title: "Every duty needs a runbook",
        text: "The runbook is the duty's how-to doc: steps, accounts, gotchas. With a good one, the next person reads it and does the duty, no meeting needed. If only you can do the duty, the runbook isn't finished.",
      },
      {
        kind: "bullets",
        items: [
          "**Keep the runbook current.** When you find a better way, update the doc, as you would fix the template after a debrief.",
          "**Report the cadence honestly.** Fulfilled means it happened this cycle. Your 1:1 will ask.",
          "**Flag overload early.** If the duty no longer fits, say so at your 1:1. Reducing or transferring it on purpose beats dropping it quietly.",
        ],
      },
      {
        kind: "p",
        text: "At each 1:1, the duties due for review come up: is it going well, is it still the right amount of work, is it still the right person? That's how your manager checks your workload.",
      },
      {
        kind: "reveal",
        prompt:
          "You're handing your flyer duty to a new volunteer. What does a good handoff look like?",
        answer:
          "Point them at the runbook (templates, brand assets, where files live, lead times) and update the duty's assignment. A quick hello helps, but if they need a meeting to start, the runbook isn't finished.",
      },
    ],
    quiz: [
      {
        prompt: "What makes a duty handoff work without a meeting?",
        options: [
          "A long email",
          "The runbook: the duty's how-to doc with the steps, accounts, and gotchas",
          "The new person's experience",
          "Handoffs always need meetings",
        ],
        answerIndex: 1,
        explanation:
          "Write the runbook so the next person can do the duty cold. That makes the duty the chapter's, not yours.",
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
          "Dropping work quietly erodes trust. The 1:1 is where load gets rebalanced on purpose, and a transferred duty with a runbook loses nothing.",
      },
      {
        prompt: "When should a duty's runbook change?",
        options: [
          "Once a year, at review time",
          "The moment you find a better way to do the duty",
          "Only when the owner changes",
          "Never, runbooks are frozen",
        ],
        answerIndex: 1,
        explanation:
          "As with a template after a debrief, put what you learn in the written source right away so the next run inherits it.",
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
        text: "Leading a project is a different job from owning a task inside one. The Project Lead makes sure the whole thing lands on time, at the standard Public Worship holds itself to. Anyone can lead a project, from a team Director to someone who just joined. What qualifies you is willingness to own the outcome and see it through, not tenure or title.",
      },
      {
        kind: "rule",
        title: "Make sure everything gets done; don't do everything",
        text: "A Project Lead doesn't execute every row. They own the timeline and the communication, pull in whoever the project needs from any team, and make sure the finished thing meets the standard. It's owning an event, one layer up.",
      },
      { kind: "heading", text: "Writing the definition of done" },
      {
        kind: "p",
        text: "A purpose line says why the project exists. A **definition of done** says how anyone will know it's finished. Without one, scope arguments can't be settled, because nobody agreed what finished means.",
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
        title: "Two people should agree on it",
        text: "Write it specifically enough that two people would agree, independently, on whether it happened. If knowing you're finished takes a judgment call, it isn't a definition of done yet.",
      },
      {
        kind: "reveal",
        prompt:
          "You're asked to \"own onboarding for new members.\" What's your first move as Project Lead?",
        answer:
          "Before assigning any task, write what done looks like. For example: every new member gets a welcome message within 24 hours and completes the Foundations trio within their first month. Without that, you can't tell whether onboarding is working.",
      },
      {
        kind: "link",
        label: "Further reading: Atlassian, What is a Definition of Done?",
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
          "There isn't one: anyone willing to own the outcome can lead a project",
          "They should wait a year before leading anything",
        ],
        answerIndex: 2,
        explanation:
          "Ownership qualifies you, not seniority. A Project Lead can be a Director or someone who just joined.",
      },
      {
        prompt: "What does a Project Lead own, according to this lesson?",
        options: [
          "Personally doing every task on the project",
          "The timeline, the communication, and the standard the finished thing must meet, not every row",
          "Nothing until the deadline",
          "Only the budget line",
        ],
        answerIndex: 1,
        explanation:
          "Foundations teaches the same distinction: make sure everything gets done; don't do everything yourself.",
      },
      {
        prompt:
          "Why does a project need a written definition of done, not just a purpose line?",
        options: [
          "It's a formality nobody checks",
          "Purpose and definition of done are the same thing",
          "Only budgeted projects need one",
          "A purpose line says why it exists; a definition of done says how anyone would know it's finished, specifically enough that two people would agree",
        ],
        answerIndex: 3,
        explanation:
          "Without a definition of done, nobody agreed what \"finished\" means, so scope arguments can't be settled.",
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
          "It's specific and checkable: two people could independently verify every clause.",
      },
    ],
  },

  // ── 26 · Works: leading a project — planning the work ───────────────────────
  {
    slug: "works-planning-the-work",
    title: "Planning the work",
    subtitle: "Breaking it down, owning every piece, and pulling people across teams",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Planning turns the definition of done into tasks, each small enough for one owner. Every task needs the three things \"Owning your yes\" asks of any commitment at Public Worship. Miss one and the task isn't assigned, however clearly you described it in the group chat.",
      },
      {
        kind: "bullets",
        items: [
          "**Owner**: one name, not \"the Music team.\" A task two people co-own is a task nobody owns.",
          "**Deadline**: a real date, not \"soon.\" If it's missed, you'd notice.",
          "**Definition of done**: what finished looks like for this task, not only the whole project.",
        ],
      },
      {
        kind: "p",
        text: "Work backward from the finish line, not forward from today. Printing takes 3 days. A vendor contract needs a week for signatures. Ask what each step requires before you promise a date.",
      },
      {
        kind: "p",
        text: "Projects are designed to cross teams. A Project Lead can ask anyone for help with a task the project needs, whatever team they usually sit on.",
      },
      {
        kind: "tree",
        caption:
          "When you're pulled onto another team's project, your own manager stays in the loop.",
        nodes: [
          { label: "Fall Flyer Campaign: Project Lead (Marketing)", depth: 0 },
          { label: "You, pulled in for social copy", depth: 1, highlight: "self" },
          { label: "Your manager (Music Lead), kept in the loop", depth: 1, highlight: "manager" },
        ],
      },
      {
        kind: "rule",
        title: "Loop in the manager, don't go around them",
        text: "Tell the person's own manager what you need and for how long. Pulling someone across teams works because it happens in the open.",
      },
      {
        kind: "reveal",
        prompt:
          "You need someone from the Music team for two afternoons of video editing help. What do you do before you message them?",
        answer:
          "Tell their manager (the Music Lead) what you need and roughly how long, so it isn't a surprise at their next 1:1. Then ask the person directly. Projects cross teams, but the home team shouldn't be surprised by where someone's week went.",
      },
      {
        kind: "link",
        label: "Further reading: Basecamp, Shape Up (breaking work into real bets)",
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
          "Same as \"Owning your yes\": miss any of the three and the task isn't assigned yet.",
      },
      {
        prompt: "Two people are both loosely responsible for the same task. What's wrong with that?",
        options: [
          "A task with two owners is a task nobody owns",
          "Nothing, more hands means it gets done faster",
          "It's fine as long as one of them is a Director",
          "Co-ownership is required for tasks over a week long",
        ],
        answerIndex: 0,
        explanation:
          "Owner means one name. Shared ownership becomes no ownership once things get busy.",
      },
      {
        prompt: "Why work backward from the deadline instead of forward from today when scheduling a task?",
        options: [
          "Forward planning is always faster",
          "Only vendors need lead-time math",
          "It doesn't matter which direction you plan from",
          "Real steps (printing, contracts, approvals) take lead time; working backward keeps the date honest",
        ],
        answerIndex: 3,
        explanation:
          "A deadline set without real lead times is a guess, not a plan.",
      },
      {
        prompt:
          "You're on the Music team and a Project Lead from Marketing asks you to help with social copy. What should already have happened?",
        options: [
          "Nothing; they should have asked your Music Lead's permission before talking to you",
          "You should refuse, since it's not your team's project",
          "The Project Lead told your manager what they need and roughly how long, so it isn't a surprise at your next 1:1",
          "Only Directors can be asked to help outside their team",
        ],
        answerIndex: 2,
        explanation:
          "Projects cross teams on purpose, and the ask is yours to accept. The Project Lead protects everyone by telling your manager early, not by asking permission in your place.",
      },
    ],
  },

  // ── 27 · Works: leading a project — the budget ──────────────────────────────
  {
    slug: "works-the-project-budget",
    title: "Building the budget",
    subtitle: "Draft, send for review, approved, and what a raise does",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Many projects have no budget; they only track work. A budget exists once real money enters. Enter a planned amount when you create the project and a Draft budget is created, or tap **Add budget** on the project page later. Plan in line items (venue, vendor, print run), not one lump sum, so your approver sees what they're saying yes to.",
      },
      {
        kind: "bullets",
        items: [
          "**Draft**: yours to edit. Nothing here spends anything.",
          "**Send for review**: a deliberate tap. The budget becomes Awaiting approval and visible to whoever can approve it.",
          "**Approve or Request changes**: the approver clears it, or sends it back with a reason. That reopens it for editing and a fresh send.",
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
        title: "The approver is never you",
        text: "Whoever sends a budget for review can never approve it. The same separation of duties governs every budget in the app, chapter or central.",
      },
      {
        kind: "rule",
        title: "Money coming in doesn't raise what you can spend",
        text: "Some projects take money in, like a class or cohort with a registration fee. Registrations show on the project's money page under the budget, with what was collected and who came on a scholarship. A **Net cost** line shows what you spent minus what came in. The budget bar does not move: collecting $150 doesn't mean $150 more was approved. The bar shows how much approval is left; Net cost shows what the project cost.",
      },
      {
        kind: "rule",
        title: "Raising the cap sends it back to Draft, and nobody is told",
        text: "Raise an approved budget's amount and it returns to Draft when you save: not Awaiting approval, not auto-submitted. The old approved figure stays the spending cap. No approver sees the increase until you tap **Send for review** again, so do both in the same sitting.",
      },
      {
        kind: "p",
        text: "Spending against an approved budget (the Public Worship card, closing receipts within the 7-day window) works as it does everywhere else in the app. \"Finances for Everyone\" covers it.",
      },
      {
        kind: "scenario",
        prompt:
          "A vendor quote for stage rental comes in 40% over your project's approved budget line. What do you do?",
        options: [
          {
            text: "Book it anyway, the event's close and there's no time to wait",
            feedback:
              "Spending past the approved cap raises a loud warning on the budget. You'd be explaining an overrun afterward instead of asking for a raise first.",
          },
          {
            text: "Quietly pad another line to cover the difference so the total looks unchanged",
            feedback:
              "Line items exist so an approver sees what they're saying yes to. Moving numbers to hide a real cost defeats that.",
          },
          {
            text: "Raise it now: adjust the plan to fit the approved cap, or raise the line and re-send the budget for review right away",
            correct: true,
            feedback:
              "Right. The old approved amount stays the cap until someone acts, so raise the gap as soon as you know. Descope to fit, or raise the amount and tap Send for review yourself.",
          },
          {
            text: "Wait a week to see if the vendor's price comes down before deciding anything",
            feedback:
              "Waiting doesn't close the gap between the quote and your cap. It only leaves less time to fix it. Raise it as soon as you know, like any other blocker.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt:
          "A project is created with a name, an owner, and a deadline, but no dollar amount. What's true about its budget right now?",
        options: [
          "It's sitting in Draft at $0, waiting for someone to send it for review",
          "No budget exists yet. Most projects only track work; a budget appears once you enter a real amount or tap Add budget",
          "It's Approved automatically at $0",
          "It's Awaiting approval, pending the Treasurer",
        ],
        answerIndex: 1,
        explanation:
          "A budget exists only once real money enters. No amount at creation means no budget yet, not a hidden Draft one.",
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
          "Chapter budgets are approved by the Treasurer or Chapter Director, central budgets by the ED or Financial Manager. Never by whoever sent it.",
      },
      {
        prompt:
          "You raise an approved project budget from $1,000 to $1,400 and don't re-send it for review. What's the live spending cap right now?",
        options: [
          "$1,400, available immediately",
          "Whatever the last transaction used",
          "$1,000, the old approved amount, until you send the raise for review and it's approved",
          "$0, spending is frozen until the raise clears",
        ],
        answerIndex: 2,
        explanation:
          "The increase returns the budget to Draft, not Awaiting approval. The old approved figure stays the cap until you resend it and someone approves the new amount.",
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
          "Never spend past an approved cap. Raise the gap early: adjust the plan or resend the raised budget, as you would escalate any other blocker.",
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
        text: "You're not doing every task, so tracking means watching everyone's slice, not only your own. The comment thread is still the progression record, and the Project Lead keeps it accurate for the whole project. A weekly pass through the task list is enough for most projects. It catches a slipping piece while there's time to fix it.",
      },
      {
        kind: "rule",
        title: "Outcomes, not tasks",
        text: "Your job is the finished thing, not a list of completed rows. A task marked done that doesn't move the project toward its definition of done is theater. Track whether the outcome is on track.",
      },
      {
        kind: "p",
        text: "\"Someone dropped out\" is not an excuse. People get sick, get busy, or take on too much, and that's normal. A task going dark because its owner went dark is not. The Project Lead builds a plan that survives people being people.",
      },
      {
        kind: "bullets",
        items: [
          "**Notice fast.** Checkpoints make a stalled task show up in days, not at the deadline.",
          "**Ask the person first.** Find out what's happening before you assume the worst or go around them.",
          "**Don't quietly take it over.** Doing their task yourself hides the real problem, the project's staffing, behind your overtime.",
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
              "That fixes this task and hides the real problem. You'll do it again next time, and nobody who could fix the staffing gap knows it exists.",
          },
          {
            text: "Message them directly today; if you don't hear back the same day, loop in their manager and yours",
            correct: true,
            feedback:
              "Right. Ask the person first, then bring in the managers on both sides while there's still time. Early is a conversation; the deadline is a crisis.",
          },
          {
            text: "Wait until the deadline passes, then explain what happened",
            feedback:
              "Waiting removes options. Act as soon as you notice the task has gone quiet.",
          },
          {
            text: "Remove them from the project without talking to them first",
            feedback:
              "You don't know what's happening yet. Asking directly might resolve this in five minutes.",
          },
        ],
      },
      {
        kind: "rule",
        title: "Escalate early, with a proposed path",
        text: "When a risk is real, tell your Director before the deadline. Bring what's stuck and what should happen next: descope, extend, or pull in more help. A blocker with a proposed path is a decision your Director can make in a minute.",
      },
      {
        kind: "p",
        text: "Then close the loop: once your Director decides, tell whoever is affected what changed and why.",
      },
      {
        kind: "link",
        label: "Further reading: Andon, the manufacturing practice of stopping the line the moment something's wrong",
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
          "You're not doing every task, so tracking means watching everyone's slice.",
      },
      {
        prompt: "Why does this lesson say to track outcomes, not tasks?",
        options: [
          "Outcomes are easier to measure than tasks",
          "A checked-off task that doesn't move the project toward its definition of done is theater; the measure is whether the outcome is on track",
          "Tasks don't matter at all",
          "Only the final task in a project counts",
        ],
        answerIndex: 1,
        explanation:
          "A full checklist with a missed outcome isn't success.",
      },
      {
        prompt:
          "A task's owner goes quiet before the deadline. What does \"'someone dropped out' is not an excuse\" mean here?",
        options: [
          "The person is always at fault",
          "The deadline moves automatically when someone drops out",
          "A stalled task can't be blamed away. The plan has to survive people being people, and the Project Lead catches it and adapts",
          "Projects should never rely on more than one person",
        ],
        answerIndex: 2,
        explanation:
          "Getting overloaded is normal. A task going dark unnoticed isn't. Catching it and adapting the plan is the Project Lead's job.",
      },
      {
        prompt: "What makes an escalation to your Director useful rather than just a complaint?",
        options: [
          "Waiting until you're certain nothing can be done before saying anything",
          "Escalating as loudly and publicly as possible",
          "Escalating only after the deadline has already passed",
          "Bringing what's stuck and a proposed path (descope, extend, or pull in help) so your Director can decide quickly",
        ],
        answerIndex: 3,
        explanation:
          "A blocker with a proposed path is a decision; one with no path is a problem your Director must solve from scratch.",
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
        text: "Marking a project Done is easy. Finishing well means the next project inherits what this one learned. Before closing, gather the people who carried it, in a room or a thread, and ask: what worked, what didn't, and what should the next Project Lead know?",
      },
      {
        kind: "rule",
        title: "Write learnings down right away",
        text: "Same reflex as duty runbooks: put what you learn in the doc, not your memory, where the next person will find it. A debrief nobody reads is just a meeting.",
      },
      {
        kind: "p",
        text: "Before you call it done, make the budget match reality: every charge attributed, every receipt closed, and the budget showing what was spent, not what was planned. A project marked Done with an open budget becomes someone else's cleanup.",
      },
      {
        kind: "bullets",
        items: [
          "**Close the last charges.** Nothing should sit unattributed once the project wraps.",
          "**True up the amount.** If you spent under or over the approved cap, the record should say so. The next Project Lead needs that data.",
          "**Name what's still open.** A pending reimbursement or invoice gets named explicitly so it isn't lost.",
        ],
      },
      {
        kind: "p",
        text: "Then thank people specifically: what each person did, not a group \"great job everyone.\" This matters most for people pulled in from another team.",
      },
      {
        kind: "reveal",
        prompt: "The giving page project just shipped. What's left before you mark it Done and move on?",
        answer:
          "Run the debrief and write it down (what worked, what didn't, what the next lead should know). Close the budget's last charges so nothing is unattributed. Thank the specific people who helped, including anyone from another team.",
      },
      {
        kind: "link",
        label: "Further reading: Atlassian, how to run a project retrospective",
        url: "https://www.atlassian.com/team-playbook/plays/retrospective",
      },
    ],
    quiz: [
      {
        prompt: "Why does this lesson say a debrief nobody reads \"is just a meeting\"?",
        options: [
          "Meetings are inherently useless",
          "Learnings only help if they're written where the next Project Lead will find them; a spoken debrief is lost with the people in the room",
          "Debriefs should never be written down",
          "Only Directors need to read debriefs",
        ],
        answerIndex: 1,
        explanation:
          "Same reflex as duty runbooks: write it down right away, or the learning is lost.",
      },
      {
        prompt: "What does closing out the budget require before a project is really done?",
        options: [
          "Financial cleanup is the Treasurer's job, never the Project Lead's",
          "Only the approved amount needs to be correct, not actual spend",
          "Every charge closed and attributed, and the budget trued up to what was actually spent",
          "Nothing, the budget can stay open indefinitely",
        ],
        answerIndex: 2,
        explanation:
          "A project marked Done with an open budget becomes someone else's cleanup. Close the charges and true up the numbers first.",
      },
      {
        prompt: "What's the better way to thank the people who helped on a project?",
        options: [
          "Thanking only the people from your own team",
          "Waiting until the next project to mention it",
          "A single group message: \"great job everyone\"",
          "Specific thanks naming what each person did, especially anyone pulled in from another team",
        ],
        answerIndex: 3,
        explanation:
          "Specific beats generic, especially for people who gave time to another team's project.",
      },
    ],
  },
];

/** The Works stream's theme entry. */
export const WORKS_THEME: Theme = {
  key: "works",
  title: "Works",
  subtitle: "Projects and duties: the chapter's ongoing work between events.",
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
