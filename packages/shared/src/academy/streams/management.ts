/**
 * The Management stream — leading the people who do the events + works work:
 * 1:1s, care + accountability, directing, the Director Standard, growing the
 * team, and partnerships. Also the "People & Leadership" theme (code key
 * stays `"management"` for backward compatibility — only the display title
 * changed) + its six courses.
 *
 * Owned exclusively by this file for content authoring — do not add
 * Management sections or courses anywhere else. See `../index` for how this
 * assembles into the full curriculum/catalog.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Management-stream sections, in curriculum order. */
export const MANAGEMENT_SECTIONS: Omit<AcademySection, "order">[] = [
  // ── 25 · Management: the 1:1 ────────────────────────────────────────────────
  {
    slug: "mgmt-one-on-one",
    title: "The 1:1: person first, then work",
    subtitle: "The conversation order, the two pulses, and who reads what",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The 1:1 is a recurring conversation with each direct report, logged in the app as a **check-in**. The form follows the order the conversation should go, and that order is deliberate.",
      },
      {
        kind: "table",
        headers: ["In order", "What you're asking"],
        rows: [
          ["**Did it happen?**", "A skipped 1:1 gets logged as skipped. Silence is data."],
          ["**The person**", "Personal and prayer updates: how they are before what they've done"],
          ["**The two pulses**", "Workload 1–10 (5–6 is right; 10 is drowning) and interest 1–10 (is this the right work?)"],
          ["**Their duties**", "Each duty due for review: being fulfilled? If not, choose a course of action"],
          ["**Their projects**", "On track or not, per project"],
          ["**Feedback**", "What went well, what to improve, and above-and-beyond moments worth naming up the chain"],
        ],
      },
      {
        kind: "rule",
        title: "Person first, then work",
        text: "You can't hold someone accountable for work while ignoring the person doing it. Care isn't a warm-up to the real conversation. It's the context that makes the work conversation honest.",
      },
      {
        kind: "p",
        text: "Read the two pulses as trends, not one-off scores. A workload sliding from 6 to 8 to 9 across three check-ins warns of burnout before it happens. An interest score stuck at 3 says re-scope their work before they leave the chapter. Duties surface on their own cadence: a **quarterly** duty doesn't clutter every **weekly** 1:1.",
      },
      {
        kind: "p",
        text: "Check-ins are read by the **chain above**: the manager, their manager, and up. A report never reads the managerial record about themselves, and you never log a check-in on yourself. That privacy keeps the notes honest.",
      },
      {
        kind: "reveal",
        prompt:
          "Your direct cancelled the last two 1:1s. It's busy season. Skip logging them?",
        answer:
          "Log them as skipped. Two skips is a pattern the chain above should see, and a conversation to open: is the load too high, is the time wrong, or are they avoiding something?",
      },
    ],
    quiz: [
      {
        prompt: "Why does the check-in ask about the person before the work?",
        options: [
          "Small talk warms up the meeting",
          "Because accountability without knowing how the person is doing isn't accountability. The personal context makes the work conversation honest",
          "The work questions are optional",
          "It's alphabetical",
        ],
        answerIndex: 1,
        explanation:
          "Person first, then work. Care is the context for accountability, not a preamble to it.",
      },
      {
        prompt: "What does a workload pulse of 9–10 mean?",
        options: [
          "They're a top performer",
          "Far too much on their plate. Rebalance before it breaks them; 5–6 is the healthy zone",
          "They should be promoted",
          "Nothing without the interest score",
        ],
        answerIndex: 1,
        explanation:
          "On the scale, 1 is far too little, 10 is far too much, and 5–6 is about right. High scores trending up are the burnout warning the 1:1 exists to catch.",
      },
      {
        prompt: "Who can read the check-in you logged about your direct report?",
        options: [
          "Everyone in the chapter",
          "The report themselves, always",
          "The chain above: you and the managers over you. The report never reads the record about themselves",
          "Only admins",
        ],
        answerIndex: 2,
        explanation:
          "Chain-above visibility keeps the notes honest. It's a managerial record, not a shared doc, and for the same reason you can't log one on yourself.",
      },
      {
        prompt: "Why doesn't every duty come up at every 1:1?",
        options: [
          "Duties are reviewed yearly",
          "Review follows the duty's own cadence: a quarterly duty surfaces quarterly, so weekly 1:1s stay focused",
          "Managers pick favorites",
          "Duties never come up at 1:1s",
        ],
        answerIndex: 1,
        explanation:
          "Each duty gets attention on its own cadence, which keeps the conversation short.",
      },
    ],
  },

  // ── 26 · Management: reviewing the work ─────────────────────────────────────
  {
    slug: "mgmt-reviewing-the-work",
    title: "Reviewing the work",
    subtitle: "Fulfilled or not, on track or not, and feedback that travels",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "After the person, the work, and the check-in makes it binary on purpose. Each duty due for review: **being fulfilled, yes or no?** Each project: **on track, yes or no?** \"How's it going?\" invites \"fine\", and \"fine\" is where problems hide.",
      },
      {
        kind: "rule",
        title: "A 'no' is a decision point, not a verdict",
        text: "\"Not fulfilled\" starts a conversation: why, and what happens next? Pick an explicit course of action. The smallest action that fixes the problem is the right one.",
      },
      {
        kind: "p",
        text: "Feedback has three parts. Say what went **well**, every time. Say what to **improve**, specifically, or skip it. Name **above-and-beyond** moments in the check-in, because the chain above reads it. Praise that reaches your manager's manager helps keep people.",
      },
      {
        kind: "reveal",
        prompt:
          'Their project is "Their project is \"mostly on track, the vendor bit is a little behind.\" On track: yes or no?" On track: yes or no?',
        answer:
          "No. \"Mostly on track\" means \"behind at the vendor.\" Mark it off track, write the blocker on the project, and decide together what unsticks it.",
      },
      {
        kind: "tip",
        text: "Before the 1:1, open their workload page: events, roles, duties and projects in one view. Each event row flags their **overdue tasks** in red; tap one to jump to it on the event. Two minutes of reading lets you open with the two things that look stuck.",
      },
    ],
    quiz: [
      {
        prompt: "Why are the work questions binary (fulfilled / on track: yes or no)?",
        options: [
          "To make the form faster to fill in",
          "Because \"how's it going\" invites \"fine\", and \"fine\" is where problems hide. The binary forces the honest call",
          "Because managers can't handle nuance",
          "The database only stores booleans",
        ],
        answerIndex: 1,
        explanation:
          "The yes/no makes sure the hard conversation happens. Nuance belongs in the conversation and the notes.",
      },
      {
        prompt: "What makes an above-and-beyond note different from saying thanks in the moment?",
        options: [
          "It's longer",
          "It travels: the chain above reads the check-in, so the praise reaches leadership with the person's name on it",
          "It comes with a bonus",
          "Nothing. It's the same thing",
        ],
        answerIndex: 1,
        explanation:
          "People stay where their work is seen beyond their own manager.",
      },
      {
        prompt: "What should you do BEFORE a 1:1 to make it useful?",
        options: [
          "Nothing. Spontaneity is best",
          "Read their workload page (events, roles, duties, projects), then open with the things that look stuck",
          "Prepare a lecture on accountability",
          "Reassign their duties as a surprise",
        ],
        answerIndex: 1,
        explanation:
          "The app shows the whole picture, so spend the 1:1 on what matters instead of collecting a verbal status report.",
      },
    ],
  },

  // ── 27 · Management: caring for people ──────────────────────────────────────
  {
    slug: "mgmt-caring-for-people",
    title: "People are a renewable resource",
    subtitle: "If you tend them: load, rotation, and feeling thanked",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "A chapter runs on volunteers and leads who *come back*. They come back when the experience was organized, they knew what to do, and they felt thanked. They quit when they were **confused, idle, or overloaded**. Those are management failures, not failures of commitment.",
      },
      {
        kind: "table",
        headers: ["They quit when…", "The tending that prevents it"],
        rows: [
          ["**Confused**", "Written duties, real runbooks, clear owners, so nobody guesses their job"],
          ["**Idle**", "Right-sized assignments; an interest pulse that someone reads"],
          ["**Overloaded**", "Workload pulses watched as trends; load rebalanced before it breaks someone"],
        ],
      },
      {
        kind: "rule",
        title: "Rotation is structure, not sentiment",
        text: "Rotate people through roles before they burn out, and before the chapter depends on one person. Rotation keeps people healthy and keeps the chapter from being one resignation away from collapse.",
      },
      {
        kind: "p",
        text: "Gratitude is built into the system: thank-you messages are planned comms rows, above-and-beyond moments get named up the chain, and completed work shows on the person's record. That makes appreciation reliable instead of dependent on memory.",
      },
      {
        kind: "reveal",
        prompt:
          "Your best organizer has run comms for six events straight and keeps saying yes. Leave them in the seat?",
        answer:
          "No. Six straight yeses with a rising workload pulse is how your best person burns out and how the chapter loses the ability to run comms without them. Rotate someone in beside them, get the runbooks written, and give your veteran a different challenge.",
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
          "It isn't. Burnout is the only reason",
          "Rotation also stops the chapter from depending on one person. No role should be one resignation from collapse",
          "It keeps things fair on paper",
          "It reduces training costs",
        ],
        answerIndex: 1,
        explanation:
          "Rotation gives you healthy people and a chapter that survives any single departure. Runbooks and templates make it cheap.",
      },
      {
        prompt: "\"Gratitude is engineered\" means…",
        options: [
          "Thank-yous are insincere",
          "Appreciation is built into the system (planned thank-you comms, above-and-beyond notes up the chain), so it happens reliably, not only when someone remembers",
          "Only the app is allowed to thank people",
          "Gratitude requires a budget line",
        ],
        answerIndex: 1,
        explanation:
          "Feeling thanked is one of the reasons people come back, so it gets a system. Memory and mood don't scale.",
      },
    ],
  },

  // ── 28 · Management: holding the line ───────────────────────────────────────
  {
    slug: "mgmt-holding-the-line",
    title: "Holding the line",
    subtitle: "Care without accountability is abandonment with a smile",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The other half of care: **the work has to happen.** Letting a duty quietly go unfulfilled isn't kindness. It dumps the load on whoever picks up the slack. It teaches the team that commitments are optional. And it denies the person the honest feedback they need to grow.",
      },
      {
        kind: "p",
        text: "When a duty comes up \"not fulfilled\" at a check-in, pick an explicit course of action from this ladder, lightest to heaviest:",
      },
      {
        kind: "table",
        headers: ["Action", "When it's right"],
        rows: [
          ["**Warning**", "First slip, capable person: name it, note it, move on"],
          ["**Reduce responsibilities**", "The load is the problem: shrink it to what they can carry"],
          ["**Transfer the responsibility**", "Wrong person-duty fit: move it, with its runbook"],
          ["**Manager took it over**", "Emergency stopgap ONLY: flag that the system failed and fix it"],
          ["**Reassigned**", "A different seat fits better than a smaller load"],
          ["**Remove from team**", "The pattern held through every lighter rung: end it honestly"],
        ],
      },
      {
        kind: "rule",
        title: "The smallest action that fixes it, chosen out loud",
        text: "Climb the ladder one rung at a time, and SAY which rung you're on. \"Consider this a warning\" is respect. Unspoken disappointment is a trap.",
      },
      {
        kind: "p",
        text: "Watch the fourth rung. Taking the work over yourself solves this week. As a habit, it teaches the plan to lie, trains the person to lean, and buries you. As with event ownership, accountability flows *through* people, not around them.",
      },
      {
        kind: "reveal",
        prompt:
          "A sweet, chronically overloaded volunteer hasn't made flyers in two months. You keep covering it yourself. What's happening?",
        answer:
          "Three failures. The volunteer is overloaded and nobody is fixing that. The duty's record says fulfilled when it isn't. And you're now doing two jobs. Name it at the 1:1, then reduce or transfer the duty, with its runbook.",
      },
    ],
    quiz: [
      {
        prompt: "Why is quietly tolerating an unfulfilled duty NOT the caring move?",
        options: [
          "It is the caring move. Pressure is harmful",
          "It dumps the load on others, teaches the team commitments are optional, and denies the person honest feedback",
          "Because the app sends automatic warnings anyway",
          "Because duties expire",
        ],
        answerIndex: 1,
        explanation:
          "Care without accountability abandons everyone involved, most of all the team carrying the slack. Holding the line is the care.",
      },
      {
        prompt: "How do you choose an action when a duty isn't being fulfilled?",
        options: [
          "Always start with removal to show seriousness",
          "The smallest action that fixes the problem, stated out loud: warning, reduce, transfer, and up the ladder as needed",
          "Never act. Wait for them to self-correct",
          "Take the duty over yourself immediately",
        ],
        answerIndex: 1,
        explanation:
          "The ladder runs lightest to heaviest, one rung at a time, and the person always knows which rung they're on.",
      },
      {
        prompt: "Why is \"the manager took it over\" flagged as a warning sign rather than a solution?",
        options: [
          "Managers aren't allowed to do work",
          "As a habit it teaches the plan to lie, trains the person to lean, and buries the manager. It's an emergency stopgap that must trigger a real fix",
          "It's fine, it's the recommended default",
          "Because it looks bad in reports",
        ],
        answerIndex: 1,
        explanation:
          "Same doctrine as event ownership: don't silently do it yourself. Take over only while arranging a real fix.",
      },
      {
        prompt: "What makes a warning respectful rather than harsh?",
        options: [
          "Softening it until it's not really a warning",
          "Saying it plainly and naming it as a warning, so the person knows exactly where they stand",
          "Delivering it publicly for transparency",
          "Skipping it and going straight to reassignment",
        ],
        answerIndex: 1,
        explanation:
          "Unspoken disappointment is a trap. A named warning gives the person a real chance to fix the pattern.",
      },
    ],
  },

  // ── 29 · Management: the org tree ───────────────────────────────────────────
  {
    slug: "mgmt-the-org-tree",
    title: "The manager tree",
    subtitle: "Your subtree is your reach and your responsibility",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every person in the chapter has at most one manager, and the manager links form a tree. The tree is the **authority model**: a manager may see and manage the workload of their *subtree* (themselves and everyone below them) and nothing beyond it.",
      },
      {
        kind: "bullets",
        items: [
          "**Your directs** are your 1:1s, your check-ins, and your calls on the action ladder.",
          "**Your subtree** is your visibility: a director sees the whole structure under them, level by level.",
          "**Beyond your subtree** is out of reach. The server enforces it; the UI hiding things is only a courtesy.",
          "**Admins** sit outside the tree: they can see everything and rewire the tree itself.",
        ],
      },
      {
        kind: "rule",
        title: "You answer for what you can see",
        text: "The subtree you can see is the subtree you answer for. If someone anywhere under you has drifting workload, noticing is your job.",
      },
      {
        kind: "p",
        text: "The **workload view** shows everything on the plate of anyone under you: events and roles, projects, duties, recent check-ins. No status meeting needed. Use it to stay honest about what the team is carrying.",
      },
      {
        kind: "reveal",
        prompt:
          "You manage Sam. Sam manages four event leads. One of them is visibly drowning. Whose problem is it?",
        answer:
          "Sam's first. The drowning lead is Sam's direct, so the 1:1 and rebalancing are Sam's to run. It's also yours, because your subtree includes both. If Sam isn't noticing, that gap is what your next 1:1 with Sam is about. You delegate action, never awareness.",
      },
    ],
    quiz: [
      {
        prompt: "What does the manager tree actually control?",
        options: [
          "Seating at chapter dinners",
          "Authority and visibility: you may see and manage the workload of your subtree, and nothing beyond it",
          "Only who gets CC'd on emails",
          "Nothing, it's decorative",
        ],
        answerIndex: 1,
        explanation:
          "The tree is the authority model, enforced on the server. Beyond your subtree is out of bounds, not just hidden.",
      },
      {
        prompt: "A lead two levels below you is quietly overloaded and their manager hasn't noticed. What's true?",
        options: [
          "Not your problem: you only answer for directs",
          "It's in your subtree, so noticing is your job too, and the manager's miss is what your next 1:1 with that manager is about",
          "You should take over their duties yourself",
          "Only an admin can act",
        ],
        answerIndex: 1,
        explanation:
          "Reach and responsibility go together. Action stays delegated (their manager runs the 1:1), but awareness never is.",
      },
      {
        prompt: "What is the workload view for?",
        options: [
          "Ranking people by output",
          "Seeing everything on one person's plate (events, projects, duties, check-ins) without a status meeting",
          "Tracking hours for payroll",
          "It's the same as the org chart",
        ],
        answerIndex: 1,
        explanation:
          "It answers \"what is this person carrying?\" from live data. Every rebalancing and every good 1:1 starts there.",
      },
    ],
  },

  // ── 30 · Management: directing ──────────────────────────────────────────────
  {
    slug: "mgmt-director-philosophy",
    title: "Directing",
    subtitle: "The dial, the absence test, and multiplying instead of doing",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Directing is event ownership one level up. You're no longer accountable for one plan happening. You're accountable for a *team of owners* whose plans all happen. The doctrine stays the same.",
      },
      {
        kind: "table",
        headers: ["Owner's doctrine", "Director's version"],
        rows: [
          ["Delegate work, never accountability", "Delegate AREAS (events, duties, projects) and hold owners to outcomes"],
          ["Oversight is a dial", "A dial PER PERSON: light on proven owners, closer on new ones, and say which setting they're on"],
          ["Build for your own absence", "Build a team that runs without you: runbooks, rotation, a bench"],
          ["Fix the plan, not the moment", "Fix the SYSTEM, not the person: most repeated failures are structure problems with a name attached"],
        ],
      },
      {
        kind: "rule",
        title: "If most of it resolves to you, you're failing at the job",
        text: "The core skill at every level is delegation. A director whose name is on everything is a bottleneck. Your output is what your people can own without you.",
      },
      {
        kind: "p",
        text: "Set the dial per person, on evidence: check-in history, statuses that stay true, escalations that come early. Turning it down as trust grows is how you grow leaders. Never turning it down is how you lose them.",
      },
      {
        kind: "reveal",
        prompt:
          "Two event leads: one's statuses are always true and blockers arrive early; the other's plan says 'fine' until things are on fire. Same oversight for both?",
        answer:
          "No, and tell them so. The first gets a light dial: read the rings, handle exceptions, stay out of the way. The second gets a closer one: walk the tabs together and check statuses against reality. State the path back: \"keep the plan true for two events and I'm gone.\" The dial is feedback, not favoritism.",
      },
      {
        kind: "p",
        text: "Apply the absence test to your team. Read it as if you're leaving for a quarter. The goal: every duty with a runbook and a healthy owner, every event with a trained lead, every project legible without a meeting. Every gap is your to-do list.",
      },
    ],
    quiz: [
      {
        prompt: "What changes when you go from owning an event to directing?",
        options: [
          "You do more of the tasks yourself",
          "The altitude: you're accountable for a team of owners whose plans all happen. Same doctrine, one level up",
          "Accountability ends: your reports carry it all now",
          "You stop using the app",
        ],
        answerIndex: 1,
        explanation:
          "Delegation still creates accountability at each layer, and the outcome still ends with you. The unit is now a team, not a plan.",
      },
      {
        prompt: "How should the oversight dial be set across your team?",
        options: [
          "The same for everyone, since fairness means uniformity",
          "Per person, on evidence: light on proven owners, closer on new or struggling ones, with the setting (and the path to lighter) said out loud",
          "Always at maximum, since trust is naive",
          "Always at minimum, since micromanagement is always wrong",
        ],
        answerIndex: 1,
        explanation:
          "The dial is per-person feedback. Earned autonomy, stated honestly, grows leaders instead of dependents.",
      },
      {
        prompt: "A director's name is on half the chapter's duties and most of its projects. What does the doctrine say?",
        options: [
          "They're the most valuable person in the chapter",
          "They're failing at the core skill, delegation, and the chapter is one person away from collapse",
          "Nothing, as long as the work gets done",
          "They should get an assistant",
        ],
        answerIndex: 1,
        explanation:
          "A director's output is what their people can own without them. Everything resolving to one person is a bottleneck, and the absence test fails on every line.",
      },
      {
        prompt: "\"Fix the system, not the person\" means…",
        options: [
          "Never hold individuals accountable",
          "When a failure repeats across people, look for the structural cause (a missing runbook, an unclear duty, a bad handoff) before blaming character",
          "Buy better software",
          "Reorganize the team every quarter",
        ],
        answerIndex: 1,
        explanation:
          "Individuals still answer for their commitments (that's the ladder). But a failure that repeats with different names attached is a structure problem, and structure is the director's to fix.",
      },
    ],
  },

  // ── 31 · Management: ownership, not babysitting ─────────────────────────────
  {
    slug: "mgmt-ownership-not-babysitting",
    title: "Ownership, not babysitting",
    subtitle: "You're not babysitting your department. You're raising it",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Directing is a trust, not a title bump. Even unpaid today, it rehearses what the movement becomes tomorrow. The baseline ask is **at least 10 focused hours a week**, alongside school, a job, family, and other callings. The real ask is ownership: \"You are not babysitting your department. You are raising it.\"",
      },
      {
        kind: "rule",
        title: "You set the direction",
        text: "Leadership offers steering and covering, not a script. The direction of your department is yours: what does excellence look like here, and what would this look like at 10x the size? You decide; you don't wait to be told.",
      },
      {
        kind: "table",
        headers: ["If your department needs…", "Your job is…"],
        rows: [
          ["**40 hrs/week of work**", "Structure a system where that happens, even though you can give only 10 yourself"],
          ["**A rotation, not a soloist**", "Recruit and organize a team: volunteers, friends, contractors if budget allows"],
          ["**To survive you missing a week**", "Build runbooks and a bench BEFORE you need them"],
        ],
      },
      {
        kind: "p",
        text: "The shape repeats in every seat. A Music Director builds a rotation and a rehearsal system, not one set list. A Creative Director builds a style guide so a chapter three cities away can make ten on-brand flyers without asking. The test: does it work when you're not in the room?",
      },
      {
        kind: "reveal",
        prompt:
          "Your department needs a weekly task done and you're the only one who knows how. Do it yourself again this week?",
        answer:
          "Once, but make it the last time. Write the runbook while you do it, then hand it off. Doing it yourself solves this week; a system solves every week after. The job is the system, not the task.",
      },
      {
        kind: "p",
        text: "This is worship, not administration for its own sake: \"Every meeting, every caption, every team you build: it's all worship... You're building altars.\"",
      },
      {
        kind: "tip",
        text: "Further reading: **Director Expectations & Leadership Philosophy** (https://www.notion.so/2197f1c177b680d99fb9e919630ed294).",
      },
    ],
    quiz: [
      {
        prompt: "What does the Director role ask for, beyond the 10-hour baseline?",
        options: [
          "Nothing more than the hours logged",
          "Ownership: building a department that runs at its real scope, not only covering the baseline yourself",
          "A title and nothing else",
          "Permission before every decision",
        ],
        answerIndex: 1,
        explanation:
          "\"You are not babysitting your department. You are raising it.\" Hours are the floor; owning the outcome is the ask.",
      },
      {
        prompt: "Your department needs 40 hours of work a week. What's the doctrine?",
        options: [
          "Work 40 hours yourself, no matter the cost",
          "Structure a system (team, runbooks, delegation) that produces 40 hours of output from your 10",
          "Scale the department down to fit 10 hours",
          "Ask Leadership to do it for you",
        ],
        answerIndex: 1,
        explanation:
          "The 10-hour ask is a floor on your time, not a ceiling on your department's output. System and team close the gap, not burnout.",
      },
      {
        prompt: "Why does the doctrine call directors \"the visionary of your department\" rather than an executor of instructions?",
        options: [
          "Leadership doesn't care what happens in your area",
          "Leadership offers steering and covering, but the direction is yours to set and own. You're not waiting to be told",
          "Because directors report to no one",
          "It's a courtesy title with no real authority",
        ],
        answerIndex: 1,
        explanation:
          "Ownership means real authority over the vision and real accountability for the outcome.",
      },
      {
        prompt: "A Creative Director builds a font/style guide and templates instead of designing every flyer personally. What is this an example of?",
        options: [
          "Micromanaging the brand",
          "Building for scale: a system that lets any chapter produce on-brand work without the Director in the room",
          "Avoiding the real work",
          "Something only large departments need",
        ],
        answerIndex: 1,
        explanation:
          "Build-for-scale means the department works when you're absent. Systems and templates are how a 10-hour Director runs a 40-hour department.",
      },
    ],
  },

  // ── 32 · Management: the SLAs ───────────────────────────────────────────────
  {
    slug: "mgmt-the-slas",
    title: "The SLAs",
    subtitle: "30 minutes, same day, two minutes a week, and never a bare no",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The Director Operating Standard turns \"stay on top of it\" into service-level agreements (SLAs): specific, checkable, and the same for every director.",
      },
      {
        kind: "table",
        headers: ["When…", "The standard"],
        rows: [
          ["A project is active", "Acknowledge a leadership message within **30 minutes**. Acknowledge, not resolve: \"Got it, thinking\" beats silence."],
          ["A decision is needed", "Resolve it **same-day** whenever possible, or propose a time to decide, or a clear next step"],
          ["Every week, no exceptions", "Send a **2-minute weekly update**: what moved, what's stuck, what you need"],
          ["Something has to be a no", "Never a bare no: offer an alternative, a scheduled discussion, or an honest assessment with a recommendation"],
        ],
      },
      {
        kind: "rule",
        title: "Silence is not acceptable",
        text: "Busy is allowed. Unreachable is not. A director who goes quiet during an active project makes the rest of the team guess.",
      },
      {
        kind: "p",
        text: "Underneath every SLA is closing the loop: a response is never a wall. A bare \"no\" reads as disengagement, even from someone who's swamped. The fix costs one more sentence.",
      },
      {
        kind: "reveal",
        prompt:
          "A leader messages you mid-week needing a decision on a vendor. You're slammed and don't have an answer yet. What's SLA-compliant?",
        answer:
          "Acknowledge within 30 minutes, even without the answer: \"Saw this. Comparing two options, I'll have a call by Thursday.\" That closes the loop: they know you saw it and when the real answer comes. Going quiet for two days breaks the SLA, even if you're working the problem.",
      },
      {
        kind: "tip",
        text: "Further reading: **Director Operating Standard (Effective 2026)**, §3 (https://www.notion.so/2d87f1c177b680c98426fb999e68b915), and **Director Operating Standards - Shortened**, §1, §3–5 (https://www.notion.so/b898b6724eaf4787849bcffa7feb3200).",
      },
    ],
    quiz: [
      {
        prompt: "What's the acknowledgment SLA for a leadership message during an active project?",
        options: [
          "Reply within a week",
          "Acknowledge within 30 minutes. Resolving can come later; silence isn't allowed",
          "No SLA: reply when convenient",
          "Only acknowledge if it's urgent",
        ],
        answerIndex: 1,
        explanation:
          "30 minutes is an acknowledgment window, not a resolution window, so nobody wonders whether the message landed.",
      },
      {
        prompt: "A decision needs to be made today. What does the standard require?",
        options: [
          "Wait until you're fully certain, however long that takes",
          "Resolve it same-day whenever possible, or propose a time to decide or a clear next step",
          "Escalate every decision to Leadership",
          "Make the decision without telling anyone",
        ],
        answerIndex: 1,
        explanation:
          "Same-day resolution, a time to decide, or a clear next step. \"Not yet, here's when\" is compliant. Silence isn't.",
      },
      {
        prompt: "Why does a 2-minute weekly update exist, given directors already have 1:1s and check-ins?",
        options: [
          "It doesn't: it's redundant with the check-in",
          "It's a fixed weekly pulse sent whether or not anything dramatic happened, so drift is caught early instead of at the next 1:1",
          "To generate more paperwork",
          "Only underperforming directors send one",
        ],
        answerIndex: 1,
        explanation:
          "The weekly update is a minimum cadence, not a status meeting. It takes 2 minutes so there's no excuse to skip it.",
      },
      {
        prompt: "What makes a response SLA-compliant when the honest answer is \"no\"?",
        options: [
          "Sending the no as fast as possible, nothing else needed",
          "Never saying no, ever",
          "Closing the loop: pairing the no with an alternative, a scheduled discussion, or an assessment with a recommendation",
          "Letting someone else deliver the no",
        ],
        answerIndex: 2,
        explanation:
          "A bare no is treated as a standards violation. One more sentence turns a dead end into a next step.",
      },
    ],
  },

  // ── 33 · Management: the repair ritual ──────────────────────────────────────
  {
    slug: "mgmt-the-repair-ritual",
    title: "The repair ritual",
    subtitle: "A missed meeting isn't the failure. An unrepaired one is",
    minutes: 3,
    blocks: [
      {
        kind: "rule",
        title: "Apologize, then propose, within 24 hours",
        text: "Missed a meeting? Within 24 hours, apologize and propose 2-3 alternate times. Both are required. An apology without a time is a feeling; times without an apology are logistics. Together they show you're overwhelmed, not disengaging.",
      },
      {
        kind: "p",
        text: "A repaired miss is a non-event. The standard also names the pattern that needs more: meetings missed without notice, slow or inconsistent responses, avoided decision ownership, or a director who has to be chased. Then Leadership has four tools:",
      },
      {
        kind: "bullets",
        items: [
          "**Adjust reporting structure**: change who the director answers to day to day",
          "**Narrow scope of responsibility**: shrink the role to what's being carried well",
          "**A time-bound Performance Improvement Plan**: explicit expectations, with weekly check-ins to evaluate progress",
          "**Redefine the role entirely**: reshape it to fit what's real",
        ],
      },
      {
        kind: "rule",
        title: "Tools, not rungs",
        text: "The four tools aren't a fixed sequence, and no \"warning\" step has to come first. Leadership picks whichever fits the pattern, or several at once. \"These actions are about operational health, not punishment\": the goal is a role and a director that fit each other.",
      },
      {
        kind: "reveal",
        prompt:
          "You missed Thursday's leadership meeting: swamped, no heads-up sent. It's Friday morning. What do you do first?",
        answer:
          "Send the repair message now, inside the 24-hour window. Apologize plainly and offer 2-3 specific times this week to catch up. Waiting for someone to ask turns a forgivable miss into the start of a pattern.",
      },
      {
        kind: "tip",
        text: "Further reading: **Director Operating Standard (Effective 2026)**, §4 and §9 (https://www.notion.so/2d87f1c177b680c98426fb999e68b915).",
      },
    ],
    quiz: [
      {
        prompt: "What are the two required parts of the repair ritual after a missed meeting?",
        options: [
          "An apology only",
          "Alternate times only, no apology needed",
          "An apology AND 2-3 proposed alternate times, both within 24 hours",
          "A written report to Leadership",
        ],
        answerIndex: 2,
        explanation:
          "Either half alone is incomplete: sorry without a next step, or logistics without acknowledgment. The ritual requires both, fast.",
      },
      {
        prompt: "A Director consistently misses meetings without notice, responds slowly, avoids decision ownership, and has to be chased. What does the standard say Leadership can do?",
        options: [
          "Nothing until a full quarter has passed",
          "Reach for whichever tool fits (adjust reporting structure, narrow scope, a time-bound Performance Improvement Plan with weekly check-ins, or redefine the role), in no required order",
          "Only issue a formal warning; nothing else is available",
          "Remove the Director immediately with no conversation",
        ],
        answerIndex: 1,
        explanation:
          "The standard lists four tools, not a fixed escalation path or a mandatory first warning. Which one applies depends on what's actually broken.",
      },
      {
        prompt: "Why does the standard describe adjusting reporting structure, narrowing scope, a PIP, or redefining the role as being \"about operational health, not punishment\"?",
        options: [
          "Because they're never actually used in practice",
          "Because the point is fixing a mismatch between the role and what's being carried, not penalizing the person",
          "Because only volunteers, never Directors, are subject to them",
          "Because Leadership needs a reason to remove someone",
        ],
        answerIndex: 1,
        explanation:
          "These are structural fixes for a role that no longer fits reality, the same doctrine as fixing the system before blaming the person.",
      },
    ],
  },

  // ── 34 · Management: building for your absence ──────────────────────────────
  {
    slug: "mgmt-building-for-your-absence",
    title: "Building for your absence",
    subtitle: "The 10-hour director, forward pull, and one cross-functional move a week",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Everything in this course points at one test: does your department survive you disappearing for a month? Building for your absence makes that test a weekly practice. The SLAs define \"reachable\" and the repair ritual covers a slip; this builds a department that doesn't need you reachable at all.",
      },
      {
        kind: "p",
        text: "Start with the math. You committed 10 focused hours, and your department needs more than that to run. The gap is the size of the system you're supposed to build. Delegation and scale thinking are the only way the math works.",
      },
      {
        kind: "rule",
        title: "Pull the department forward",
        text: "Proactivity has a number: **at least 2 proactive leadership actions a week**. These are moves nobody asked for that pull the department forward before a gap forces them. A director who only responds to requests isn't leading.",
      },
      {
        kind: "bullets",
        items: [
          "**Cross-project mindset**: your department isn't isolated. Flag a blocker in someone else's area; offer a resource someone else needs.",
          "**At least 1 cross-functional leadership action a week**: a deliberate move that helps outside your own lane.",
          "**The daily availability window**: you don't need to be reachable all day, but you commit to a real window every day. Crunch weeks widen it.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You've hit your 10 hours this week just keeping your own duties fulfilled. There's no time left for anything proactive. Is that a compliant week?",
        answer:
          "No. It's a warning sign. Ten hours spent entirely on your own tasks, with no proactive or cross-functional moves, means the department still runs on you. The standard measures building what runs without you, not hours alone.",
      },
      {
        kind: "tip",
        text: "Further reading: **Director Expectations & Leadership Philosophy** (https://www.notion.so/2197f1c177b680d99fb9e919630ed294); **Director Operating Standard (Effective 2026)**, §2, §6, §8 (https://www.notion.so/2d87f1c177b680c98426fb999e68b915); and **Director Operating Standards - Shortened**, §3, §6 (https://www.notion.so/b898b6724eaf4787849bcffa7feb3200).",
      },
    ],
    quiz: [
      {
        prompt: "What does \"building for your absence\" actually test?",
        options: [
          "How many hours you personally log",
          "Whether the department keeps running if you're gone for a month. The system, not the person, is what's evaluated",
          "Whether you've hired a replacement",
          "How well you delegate paperwork",
        ],
        answerIndex: 1,
        explanation:
          "It's the stream's absence test applied to a whole department: every duty covered, every gap visible, without you in the room.",
      },
      {
        prompt: "What does \"forward pull\" require, concretely?",
        options: [
          "Waiting for Leadership to assign tasks",
          "At least 2 proactive leadership actions a week: moves nobody asked for that push the department ahead of a gap",
          "One action a year at review time",
          "Nothing: reacting quickly is enough",
        ],
        answerIndex: 1,
        explanation:
          "Forward pull has a number on purpose. A director who only responds to requests is keeping pace, not leading.",
      },
      {
        prompt: "A director spends their entire 10 hours firefighting their own duties, week after week, with no proactive or cross-functional moves. What does the standard say?",
        options: [
          "That's a fully compliant week: the hours were logged",
          "It's a warning sign: time spent is not the same as building capacity that survives your absence",
          "It means the department needs fewer duties",
          "It only matters if a leadership message goes unanswered",
        ],
        answerIndex: 1,
        explanation:
          "Logging hours on your own tasks and building a department that runs without you are different activities. The forward-pull requirement keeps the second from being skipped.",
      },
      {
        prompt: "What is the \"cross-project mindset\" asking a director to do?",
        options: [
          "Ignore anything outside their own department",
          "Notice blockers or resources relevant to other areas and act on at least one a week, on purpose",
          "Take over other directors' departments",
          "Only relevant for Executive Directors",
        ],
        answerIndex: 1,
        explanation:
          "At least 1 cross-functional leadership action a week keeps directors from optimizing their own silo at the expense of the whole chapter.",
      },
    ],
  },

  // ── 35 · Management: empower first, appoint second ──────────────────────────
  {
    slug: "mgmt-empower-first",
    title: "Empower first, appoint second",
    subtitle: "Faithfulness before position: titles follow fruit",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Recruiting starts with a mindset: we empower people to do the work before giving them a title. Everyone, from a first-time volunteer to a future director, serves through the same trial before the title arrives. Faithfulness before position: titles follow fruit.",
      },
      {
        kind: "p",
        text: "Public Worship is early-stage and building a foundational team, not filling fixed slots. So even a small role should carry **director-level potential**: initiative, clear communication, ownership, people skills. \"We are building founders, not just volunteers.\"",
      },
      {
        kind: "rule",
        title: "The specialist exception",
        text: "Strong individual contributors (video editors, designers, engineers) are the deliberate exception. Depth in a craft is the qualification; director-level potential is a bonus, not a gate.",
      },
      {
        kind: "p",
        text: "\"Every person passes through the same door.\" The five-step pipeline is identical for a friend, a stranger who filled out a public interest form, or someone already serving informally:",
      },
      {
        kind: "table",
        headers: ["Step", "What happens"],
        rows: [
          ["**1 · Create the role**", "Define it before you go looking: purpose, responsibilities, ideal candidate traits"],
          ["**2 · Find candidates, in order**", "In-house, then the volunteer interest pool, then a public call/interest form, then personal networks. Always in that order, never skipping to \"who do I know\""],
          ["**3 · Interview**", "At least two team members, one shared rubric (see the next lesson)"],
          ["**4 · Empowerment Trial**", "1–2 months of real, bounded work before anything is official"],
          ["**5 · The Director decides**", "Final say, made prayerfully, and a templated outcome message either way"],
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A friend of a team member wants a role, and they seem like a great personal fit. Can they skip straight to an offer?",
        answer:
          "No. Same door as everyone else: the ordered candidate search, the shared-rubric interview, and the Empowerment Trial. Skipping steps for someone familiar is the shortcut the pipeline exists to prevent. Fit gets confirmed in practice, not assumed.",
      },
      {
        kind: "tip",
        text: "Further reading: **Recruitment Philosophy & Mindset** (https://www.notion.so/aedcbb918d394a31bb9b36df8e1683a1). The five-step pipeline is reconstructed from a verified crawl summary of the \"Adding Someone to the Team\" hub page, captured 2026-07-17 after it went private. Flagged for an owner spot-check: https://www.notion.so/af1344859be446d38b40c708834409f9.",
      },
    ],
    quiz: [
      {
        prompt: "What does \"Faithfulness before position\" mean in practice?",
        options: [
          "Titles are given up front to attract candidates",
          "Nobody gets a title until they've proven fit through real work. The title follows demonstrated fruit, not the other way around",
          "Only faithful church members can serve",
          "Positions are assigned by seniority",
        ],
        answerIndex: 1,
        explanation:
          "Empower first, appoint second: everyone works the role before wearing the title, so the title means something when it arrives.",
      },
      {
        prompt: "Why should even a small role look for director-level potential?",
        options: [
          "It shouldn't: small roles need less",
          "Because the team is being built as a foundational, founder-generation team in an early-stage organization, with an explicit exception for specialists",
          "Titles are handed out regardless of potential",
          "Only true for roles based in one city",
        ],
        answerIndex: 1,
        explanation:
          "This is an early-stage bias, not a permanent rule, and it explicitly exempts strong individual contributors.",
      },
      {
        prompt: "What order does the candidate search follow, and why does the order matter?",
        options: [
          "Personal networks first, since trust is already established",
          "In-house, then the volunteer interest pool, then a public call, then personal networks, in that order, so every candidate passes through the same door",
          "Whatever order is fastest each time",
          "Public call only. No other sources allowed",
        ],
        answerIndex: 1,
        explanation:
          "The fixed order stops personal connections from becoming a silent shortcut around the process.",
      },
      {
        prompt: "What's the deliberate exception to the founder-potential bias?",
        options: [
          "There is no exception",
          "Specialists / strong individual contributors (e.g. video editors, designers, engineers), chosen mainly for craft depth",
          "Directors are exempt from screening",
          "Volunteers under 25",
        ],
        answerIndex: 1,
        explanation:
          "The founder-potential bias fits generalist and leadership roles. It's relaxed for roles where deep craft skill is the job.",
      },
    ],
  },

  // ── 35b · Management: the front door ────────────────────────────────────────
  {
    slug: "mgmt-the-front-door",
    title: "The front door",
    subtitle: "Where the pipelines live now: two public doors, and a promise with a clock on it",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The five steps now live in the product. **publicworship.life/team** lists the open seats, and anyone can apply. Every application lands in **People → Recruiting**, the same door for strangers and friends. Each file holds the answers, rubric, trial brief, and call. Edit the questions under **Application form**.",
      },
      {
        kind: "p",
        text: "A role gets published only when someone can write down three things. These are the **outcomes** it's accountable for (and how we'd know one landed), what the holder can **decide** without asking, and what the role is **not**. If those can't be written, the seat isn't ready, and no candidate gets contacted.",
      },
      {
        kind: "table",
        headers: ["Stage on the desk", "What it means"],
        rows: [
          ["**Applied**", "It landed. Nobody has read it yet, and the clock is running"],
          ["**Reading it**", "A person is reading it against the role: covering, capacity, outcomes"],
          ["**Interview · heart, then role**", "The two meetings, same rubric both times"],
          ["**Empowerment Trial**", "Real bounded work, with the midpoint and decision dates already on the file"],
          ["**Awaiting the call**", "The reviews are in and we owe this person an answer"],
          ["**Placed · Not now · Declined · Withdrew**", "Closed, with a reason recorded and a message sent"],
        ],
      },
      {
        kind: "rule",
        title: "Two pipelines, one owner",
        text: "A **seat** on the chart owns outcomes and decisions. Applying at /team takes weeks: interviews, a trial, a director's call. A **volunteer** helping at a gathering signs up at /serve, a person replies, and they join the roster tagged with their skills. One person owns both. A trial to hand out lanyards is absurd; a raised hand isn't enough to hand someone a chapter.",
      },
      {
        kind: "rule",
        title: "What the desk won't let you skip",
        text: "You can't **place** someone on one person's read: it takes two people's rubric reviews, or the button refuses. A **not-now** needs a date to come back. You can't close a file without writing **why** (for us, never sent); the candidate gets a warm, editable message instead. Only a director (the People Director or the ED) can close a file. A People Associate can read applications, book and file interviews, and start a trial.",
      },
      {
        kind: "p",
        text: "The page promises that **a human replies, either way**. At the top of the desk, in red, are the files waiting over a week unanswered, the ones nobody owns, and trials past their midpoint.",
      },
      {
        kind: "reveal",
        prompt:
          "A director you trust says a candidate is obviously right and asks to skip the trial; they've known them for years. What happens?",
        answer:
          "Nothing changes. Familiarity is the shortcut the one-door rule exists to prevent, and the desk won't place a file on one review anyway. You can make the trial short and real. File how they reached us as \"personal network\" so the ordered search stays honest.",
      },
    ],
    quiz: [
      {
        prompt: "What has to be true before a seat gets published on /team?",
        options: [
          "Someone has time to interview",
          "Its outcomes, the decisions the holder gets to make, and what the role is NOT can all be written down",
          "The budget is approved",
          "A candidate has already been found",
        ],
        answerIndex: 1,
        explanation:
          "If those three can't be written, the seat isn't ready. A responsibility handed over without stated outcomes and authority comes straight back.",
      },
      {
        prompt: "How many people's rubric reviews does it take to PLACE a candidate?",
        options: [
          "One. The director decides anyway",
          "At least two different people's reviews; the desk refuses the placement otherwise",
          "Every director on the team",
          "None, if the trial went well",
        ],
        answerIndex: 1,
        explanation:
          "\"At least two team members, one shared rubric.\" The Director still makes the call, but not on one person's read. Filing twice yourself doesn't count as two.",
      },
      {
        prompt: "What does a \"not now\" require that a decline doesn't?",
        options: [
          "A longer message",
          "A date we'll actually come back to it",
          "The ED's approval",
          "Nothing. They're the same",
        ],
        answerIndex: 1,
        explanation:
          "A not-now is a promise. Without a revisit date it's a no nobody had to say out loud, the failure the warm-no doctrine exists to prevent.",
      },
      {
        prompt: "Who can close a candidate's file?",
        options: [
          "Anyone with hiring desk access",
          "Only a director: the People Director or the ED. Running the pipeline and making the call are separate powers",
          "Whoever ran the last interview",
          "The candidate's referrer",
        ],
        answerIndex: 1,
        explanation:
          "An associate can move candidates, file reviews, and start trials, but can't end someone's process. The app enforces that separation.",
      },
    ],
  },

  // ── 36 · Management: the interview ──────────────────────────────────────────
  {
    slug: "mgmt-the-interview",
    title: "The interview",
    subtitle: "Two meetings, one covering question, and a rubric that ranks character first",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "\"Every interview is an encounter... we're inviting them into something sacred.\" It's easy to run an interview like a transaction. This structure makes it a two-way, honest conversation.",
      },
      {
        kind: "table",
        headers: ["Meeting", "Focus"],
        rows: [
          ["**1 · Heart & Alignment** (20–30 min)", "Their story, why they want to serve, chemistry, communication, humility, and sharing the mission plainly"],
          ["**2 · Role Fit** (20 min, optional)", "Role-specific depth, scope, and the Empowerment Trial. Combine with Meeting 1 if time is short"],
        ],
      },
      {
        kind: "rule",
        title: "Availability is a gate",
        text: "Ask about time commitment early and honestly, for everyone: roughly 10 hrs/week for directors, 5 for team members, plus recurring meeting attendance. If the time doesn't work, it's a non-starter, however strong the candidate.",
      },
      {
        kind: "p",
        text: "Ask everyone the **spiritual covering** question plainly: where is your home church, how are you attending and giving there, and what draws you here specifically? It isn't gatekeeping faith. The concern is stated openly: \"we want people who are already spiritually covered... not looking to make Public Worship their church.\"",
      },
      {
        kind: "p",
        text: "When two candidates are close, the rubric breaks the tie in a fixed order: **character**, then **communication**, then **people skills**, then **execution**, then **availability**. The rationale: \"Skill can be trained; heart can't.\" The Empowerment Trial reuses the same rubric to confirm the call.",
      },
      {
        kind: "reveal",
        prompt:
          "A candidate is clearly the most technically skilled applicant, but their answers about handling feedback and team tension are vague and defensive. Character or execution: which wins?",
        answer:
          "Character wins the tiebreak. Execution is trainable inside the Empowerment Trial. How someone handles correction and team tension usually isn't visible until it's tested, which is what the trial is for. Strong skill with weak character is a flag to slow down, not fast-track.",
      },
      {
        kind: "tip",
        text: "Further reading: **Interview Guide** (https://www.notion.so/fd030aac3b66443a946111b2d98f200e).",
      },
    ],
    quiz: [
      {
        prompt: "What's the purpose of Meeting 1 (Heart & Alignment)?",
        options: [
          "Testing role-specific technical skill in depth",
          "Understanding who they are and why they want to serve (chemistry, communication, humility) and sharing the mission plainly",
          "Negotiating their start date",
          "Reviewing their resume line by line",
        ],
        answerIndex: 1,
        explanation:
          "Meeting 1 is about the person and alignment. Role-specific depth is Meeting 2's job, or the same conversation if time is short.",
      },
      {
        prompt: "Why is availability confirmed early and treated as a hard gate?",
        options: [
          "It isn't a gate. Commitment is negotiable later",
          "Because if the realistic time commitment doesn't work, no amount of talent changes that. Better to know before investing further",
          "Only directors need to answer it",
          "It's asked last, after the offer",
        ],
        answerIndex: 1,
        explanation:
          "The guide says to confirm capacity early, for everyone. A strong candidate with no real time available is still a no.",
      },
      {
        prompt: "What is the spiritual covering question actually screening for?",
        options: [
          "Whether the candidate shares the team's exact denomination",
          "Whether the candidate is already planted, attending, and giving at their own home church, not looking to make this organization their church home",
          "Whether the candidate has ever attended church",
          "Nothing. It's a formality",
        ],
        answerIndex: 1,
        explanation:
          "People should be spiritually covered elsewhere, so serving here is an overflow of that, not a substitute.",
      },
      {
        prompt: "In what order does the rubric rank candidates when choosing between close options?",
        options: [
          "Execution, then availability, then character",
          "Character, then communication, then people skills, then execution, then availability",
          "Availability first: time commitment trumps everything else",
          "Whoever interviews best on the day",
        ],
        answerIndex: 1,
        explanation:
          "Character leads because skill and execution can be built inside the Empowerment Trial; character is what the trial is designed to confirm, not create.",
      },
    ],
  },

  // ── 37 · Management: the trial ──────────────────────────────────────────────
  {
    slug: "mgmt-the-trial",
    title: "The trial",
    subtitle: "Real work, bounded scope, and no Slack seat yet",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The interview tells you what someone says about themselves. The Empowerment Trial tells you what's true: 1–2 months of real, bounded work before anything is official. \"It confirms fit in practice and lets them experience our culture from day one.\"",
      },
      {
        kind: "table",
        headers: ["Track", "Check-in cadence"],
        rows: [
          ["**Team Member**", "Midpoint at 2 weeks · final review + decision at 4 weeks"],
          ["**Director**", "Midpoint at 1 month · final review + decision at 2 months"],
        ],
      },
      {
        kind: "rule",
        title: "Empowered, but bounded",
        text: "The trial gives real work, not busywork: design mockups, outlines, event plans, concept pitches. It withholds anything hard to walk back: no posting to official accounts, no managing budgets, no handling sensitive data. The candidate isn't added to Slack yet. They're connected only to the people needed for the assigned work.",
      },
      {
        kind: "p",
        text: "The trial uses the interview rubric: communication and response time, people skills and relational grace, initiative and follow-through, excellence and ownership, alignment with mission. More than one person can complete a midpoint or final review, so the decision doesn't ride on one impression.",
      },
      {
        kind: "reveal",
        prompt:
          "Midway through a Director-track trial, the candidate asks to be added to Slack so they can \"get a head start\" on team culture. What do you say?",
        answer:
          "Not yet. The trial connects them only to the people needed for their assigned work; broader access waits for the decision at the two-month mark. Say it plainly: \"that comes after the decision, not before.\" That's kinder than a vague stall.",
      },
      {
        kind: "tip",
        text: "Further reading: **Empowerment Trial** (https://www.notion.so/bde60f9c5c8f4262a56f9b0204ce4862).",
      },
    ],
    quiz: [
      {
        prompt: "What is the Empowerment Trial for?",
        options: [
          "A formality before an already-made decision",
          "Confirming fit IN PRACTICE: real work, evaluated on the same rubric as the interview, before anything is made official",
          "Free labor before paying someone",
          "Testing only technical skill",
        ],
        answerIndex: 1,
        explanation:
          "It tests what an interview can't: how someone performs and behaves inside real, bounded work.",
      },
      {
        prompt: "What's explicitly OFF-LIMITS during the trial?",
        options: [
          "Design mockups and concept pitches",
          "Posting to official accounts, managing budgets, or handling sensitive data, plus Slack access until the decision is made",
          "Attending check-ins",
          "Working on event plans",
        ],
        answerIndex: 1,
        explanation:
          "The trial gives real work and withholds anything hard to walk back, on purpose.",
      },
      {
        prompt: "How does the check-in cadence differ between a Team Member and a Director trial?",
        options: [
          "They're identical",
          "Team Member: midpoint at 2 weeks, decision at 4 weeks. Director: midpoint at 1 month, decision at 2 months, a longer runway for the larger role",
          "Directors skip the trial entirely",
          "Team Members get twice as long as Directors",
        ],
        answerIndex: 1,
        explanation:
          "The longer director track gives more time to show ownership and initiative in a bigger role.",
      },
    ],
  },

  // ── 38 · Management: the call ────────────────────────────────────────────────
  {
    slug: "mgmt-the-call",
    title: "The call",
    subtitle: "A prayerful decision, the Director's final say, and a no that stays warm",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The pipeline, interview, and trial inform one decision; they don't replace it. \"The Director has the final say... this process supports their prayerful decision; it doesn't replace it.\" The rubric and trial are evidence. The call is a person's judgment. Either way, the candidate gets a templated outcome message, sent promptly, so they aren't left guessing.",
      },
      {
        kind: "table",
        headers: ["Outcome", "What the message does"],
        rows: [
          ["**Acceptance**", "Names the empowerment plainly (\"we're excited to empower you to lead in this area\") and moves straight to what's next"],
          ["**Warm rejection**", "Stays warm, not a form letter. \"We've been talking with a few people... would love to stay connected\" keeps the door open"],
        ],
      },
      {
        kind: "rule",
        title: "The warm no is doctrine, not politeness",
        text: "A candidate who wasn't chosen still gave real time to a real trial. A cold, silent, or delayed no undoes the goodwill the empowerment-first pipeline builds. How you say no is as much the culture as how you say yes.",
      },
      {
        kind: "p",
        text: "\"Skill can be trained; spirit can't.\" That's why the pipeline spends most of its effort screening for character, alignment, and fit. Anything trainable (a skill, a workflow, a tool) gets taught inside the role, after the call.",
      },
      {
        kind: "reveal",
        prompt:
          "The trial went well on paper, but the Director has a quiet, hard-to-articulate hesitation about fit. What should drive the decision?",
        answer:
          "The Director's prayerful judgment, including the hesitation. The process supports the decision; it doesn't replace it. Unease that survives a full trial and interview is data worth weighing, even when the checklist looks complete. If the answer is no, it still goes out warmly, on the same template.",
      },
      {
        kind: "tip",
        text: "Further reading: **Outcome Messages** (https://www.notion.so/926362a032d143d6b1a3a7847187acf8) and the \"Adding Someone to the Team\" hub (https://www.notion.so/af1344859be446d38b40c708834409f9). Both pages went private before they could be archived. This lesson is built from verified crawl summaries captured 2026-07-17, flagged for an owner spot-check.",
      },
    ],
    quiz: [
      {
        prompt: "Who makes the final hiring decision, and what role does the rubric/trial play?",
        options: [
          "The rubric score alone decides automatically",
          "The Director decides, prayerfully. The interview rubric and trial inform that judgment; they don't replace it",
          "A committee vote",
          "Whoever ran the interview",
        ],
        answerIndex: 1,
        explanation:
          "Process supports the decision; it doesn't substitute for it. The Director's judgment decides.",
      },
      {
        prompt: "Why does a declined candidate still get a warm, templated message instead of silence?",
        options: [
          "It's just a courtesy with no real purpose",
          "Because they gave real time to a real trial, and a cold or absent no undermines the trust the empower-first approach depends on",
          "Warm rejections are legally required",
          "Only accepted candidates get a message",
        ],
        answerIndex: 1,
        explanation:
          "The warm no is part of the culture. A templated, warm rejection keeps the relationship and the door open.",
      },
      {
        prompt: "What does \"Skill can be trained; spirit can't\" explain about the whole pipeline?",
        options: [
          "That skills don't matter at all",
          "Why the process spends most of its screening effort on character and alignment (the untrainable part), while trainable skill gets taught after the call",
          "That spiritual maturity is graded numerically",
          "That the trial is only about technical output",
        ],
        answerIndex: 1,
        explanation:
          "It's why the rubric ranks character first and why the trial counts for more than a resume.",
      },
    ],
  },

  // ── 39 · Management: the four gates ─────────────────────────────────────────
  {
    slug: "mgmt-the-four-gates",
    title: "The four gates",
    subtitle: "Faith, mission, the ask, and the brand: clear all four or it's a no",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Partnership requests (sponsorships, cross-promo, collabs, someone wanting to piggyback on an event) need a decision fast enough not to waste anyone's momentum. The four gates are a quick, repeatable filter for that.",
      },
      {
        kind: "table",
        headers: ["Gate", "The question"],
        rows: [
          ["**1 · Faith & beliefs**", "Does the organizer and project align with our faith and statement of beliefs? **Non-negotiable**: any conflict here is a decline, whatever the upside."],
          ["**2 · Mission fit**", "Does this serve the actual mission? If the fit isn't obvious, ask the partner for a written justification instead of guessing for them."],
          ["**3 · The ask + director buy-in**", "What's being requested: infrastructure, a social post, cash, people? Does the director who owns that resource agree?"],
          ["**4 · Brand exposure & trust**", "How exposed is the brand, and can we vouch for the other side? \"No accidental Ponzi schemes.\" Check credibility before you cosign."],
        ],
      },
      {
        kind: "rule",
        title: "A hard fail on any gate ends it there",
        text: "The gates run in order. A strong Gate 4 doesn't argue a Gate 1 fail back to life. \"We don't steer from the main plot, even if people are asking for it.\" Clear all four; there's no partial credit.",
      },
      {
        kind: "p",
        text: "Gate 3 is where good-sounding partnerships often die, by design. A partner wanting a shoutout the same week you promote your own event is a real conflict. A Marketing Director's no to protect that is a *valid* no, not an obstacle to route around.",
      },
      {
        kind: "reveal",
        prompt:
          "A well-known, well-funded organization wants to co-brand an event with you next month. Their beliefs statement doesn't obviously conflict with yours, but it's vague and you can't quite tell.",
        answer:
          "Don't wave Gate 1 through on vagueness. Ask directly. If real ambiguity remains after asking, that is the answer: slow down instead of assuming alignment because the partner is prominent or well-funded. Size and funding are Gate 4 considerations at best and say nothing about Gate 1.",
      },
      {
        kind: "tip",
        text: "Further reading: **SOP: Partnership Evaluation Process** (https://www.notion.so/ded2e9ae50cf4e779ae7423e7daaa10b).",
      },
    ],
    quiz: [
      {
        prompt: "What happens when a partnership request hard-fails Gate 1 (faith & beliefs)?",
        options: [
          "It moves on to Gate 2 for a second opinion",
          "It's declined regardless of any upside on the other gates. Gate 1 is explicitly non-negotiable",
          "It gets approved with conditions",
          "Only the ED can override it",
        ],
        answerIndex: 1,
        explanation:
          "Gate 1 isn't weighed against the others. A conflict there ends the evaluation on its own.",
      },
      {
        prompt: "A partner's mission fit isn't obvious at a glance. What's the correct next step?",
        options: [
          "Decline automatically since fit isn't obvious",
          "Ask the partner for a written justification of how it serves the mission, rather than guessing on their behalf",
          "Approve it and see how it goes",
          "Skip straight to Gate 4",
        ],
        answerIndex: 1,
        explanation:
          "Ambiguity at Gate 2 has a specific move: ask, don't assume. A written justification turns a guess into an answer.",
      },
      {
        prompt: "Why can a Marketing Director's \"no\" to a request for a social shoutout be valid, even if the partnership otherwise looks appealing?",
        options: [
          "Marketing Directors can veto anything for any reason",
          "Gate 3 requires buy-in from whichever director owns the specific resource being asked for, and a real conflict is a legitimate reason to decline that resource",
          "Marketing is the only gate that matters",
          "Social posts never require sign-off",
        ],
        answerIndex: 1,
        explanation:
          "Gate 3 ties sign-off to the resource requested. A conflict, like competing with your own event promo, is what Gate 3 exists to catch.",
      },
    ],
  },

  // ── 40 · Management: frontline no, final yes ────────────────────────────────
  {
    slug: "mgmt-frontline-no-final-yes",
    title: "Frontline no, final yes",
    subtitle: "Anyone can decline. Only one person can approve.",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The four gates tell you *what* to check. This lesson covers *who* decides, and it's asymmetric on purpose: \"The frontline can always say no. Only the ED says the final yes.\"",
      },
      {
        kind: "table",
        headers: ["If the partner is asking for…", "Sign-off required from"],
        rows: [
          ["Social posts / cross-promotion / shoutouts", "Marketing & Creative Director"],
          ["Event infrastructure, production, or presence at an event", "Events & Production Director"],
          ["Cash, budget, or a financial commitment", "Financial Manager and the Executive Director"],
          ["Volunteers / people resources", "Operations Director"],
          ["Worship, music, or programming talent", "Music & Worship Director"],
          ["Overall partnership across multiple areas", "Partnerships Director coordinates; ED gives the final stamp"],
        ],
      },
      {
        kind: "rule",
        title: "No sign-off, no deal",
        text: "The routing table is a gate, not a courtesy CC. If the director who owns the requested resource doesn't sign off, the partnership doesn't happen, however enthusiastic the frontline or the ED is.",
      },
      {
        kind: "p",
        text: "Any single person in the flow can end a bad partnership early without anyone else's agreement: the frontline screening it, or a director declining their piece. Approving takes the full chain: frontline clearance, the affected director's sign-off, AND the ED's rubber stamp. Declining is cheap and fast; approving is deliberately not.",
      },
      {
        kind: "p",
        text: "The same shape fits any chapter-level decision that commits someone else's resource: one person can always stop it, and only the top role can approve it.",
      },
      {
        kind: "reveal",
        prompt:
          "The frontline is excited about a partnership and the affected director hasn't responded yet. The ED is asking for a quick answer. Can the frontline give a provisional yes to keep momentum?",
        answer:
          "No. The flow has no provisional-yes state. Without the affected director's sign-off, the honest answer is \"not yet,\" not a soft yes that gets walked back. The frontline can promise a follow-up with a firm timeline instead of an outcome nobody has approved.",
      },
      {
        kind: "tip",
        text: "Further reading: **SOP: Partnership Evaluation Process** (https://www.notion.so/ded2e9ae50cf4e779ae7423e7daaa10b).",
      },
    ],
    quiz: [
      {
        prompt: "Who has the authority to decline a partnership request outright?",
        options: [
          "Only the Executive Director",
          "The frontline can always say no. Declining doesn't require anyone else's agreement",
          "Only the affected director",
          "Nobody: every request must go to a full review",
        ],
        answerIndex: 1,
        explanation:
          "Any no can happen fast and alone. Only a yes needs the full chain.",
      },
      {
        prompt: "A partner wants both a social post and event infrastructure. Whose sign-off is required?",
        options: [
          "Only the Partnerships Director's",
          "Both the Marketing & Creative Director AND the Events & Production Director. Each resource routes to the director who owns it",
          "Only the ED's, since it spans multiple areas",
          "Whoever answers first",
        ],
        answerIndex: 1,
        explanation:
          "The routing table matches sign-off to the SPECIFIC resource asked for. Multiple asks mean multiple required sign-offs, not one blanket approval.",
      },
      {
        prompt: "What's the one step that must happen before ANY partnership is finally approved, regardless of how enthusiastic everyone else is?",
        options: [
          "A written contract",
          "The Executive Director's final rubber stamp, after frontline clearance and the affected director's sign-off",
          "A public announcement",
          "Nothing. Director sign-off is sufficient on its own",
        ],
        answerIndex: 1,
        explanation:
          "\"Only the ED says the final yes.\" Frontline clearance and director buy-in are necessary but not sufficient; the ED's stamp is the last gate and can't be skipped.",
      },
    ],
  },
];

/** The Management stream's theme entry. */
export const MANAGEMENT_THEME: Theme = {
  key: "management",
  title: "People & Leadership",
  subtitle:
    "Lead the people: 1:1s, delegation, care that still holds the line, " +
    "the Director Standard, growing the team, and partnerships.",
};

/** The Management stream's courses, in catalog order. */
export const MANAGEMENT_COURSES: Course[] = [
  {
    slug: "the-one-on-one",
    themeKey: "management",
    title: "The one-on-one",
    level: "leader",
    audience: "team",
    description:
      "The manager's basic unit: person first, the two pulses, then the " +
      "work, and feedback that travels up the chain.",
    icon: "coffee",
    moduleSlugs: ["mgmt-one-on-one", "mgmt-reviewing-the-work"],
  },
  {
    slug: "care-and-accountability",
    themeKey: "management",
    title: "Care & accountability",
    level: "leader",
    audience: "team",
    description:
      "Caring for people while holding the line: load, rotation, gratitude, " +
      "and the action ladder for when work isn't happening.",
    icon: "heart",
    moduleSlugs: ["mgmt-caring-for-people", "mgmt-holding-the-line"],
  },
  {
    slug: "directing",
    themeKey: "management",
    title: "Directing",
    level: "leader",
    audience: "team",
    description:
      "The director's philosophy: the manager tree, the oversight dial per " +
      "person, and building a team that runs without you.",
    icon: "users",
    moduleSlugs: ["mgmt-the-org-tree", "mgmt-director-philosophy"],
  },
  {
    slug: "the-director-standard",
    themeKey: "management",
    title: "The Director Standard",
    level: "leader",
    audience: "role",
    description:
      "What Directors are held to: ownership over babysitting, " +
      "response-time SLAs, the repair ritual, and building a department " +
      "that survives your absence.",
    icon: "flag",
    moduleSlugs: [
      "mgmt-ownership-not-babysitting",
      "mgmt-the-slas",
      "mgmt-the-repair-ritual",
      "mgmt-building-for-your-absence",
    ],
  },
  {
    slug: "growing-the-team",
    themeKey: "management",
    title: "Growing the team",
    level: "leader",
    audience: "team",
    description:
      "Empower first, appoint second: the five-step hiring pipeline, where it " +
      "lives now (public seats at /team and the Recruiting desk), the interview " +
      "rubric, the Empowerment Trial, and a kind call either way.",
    icon: "user-plus",
    moduleSlugs: [
      "mgmt-empower-first",
      "mgmt-the-front-door",
      "mgmt-the-interview",
      "mgmt-the-trial",
      "mgmt-the-call",
    ],
  },
  {
    slug: "partnerships",
    themeKey: "management",
    title: "Partnerships",
    level: "leader",
    audience: "team",
    description:
      "The four gates every partnership has to clear, and who actually " +
      "gets to say yes: frontline can always decline, only the ED gives " +
      "the final approval.",
    icon: "link-2",
    moduleSlugs: ["mgmt-the-four-gates", "mgmt-frontline-no-final-yes"],
  },
];
