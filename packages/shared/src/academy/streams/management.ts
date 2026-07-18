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

  // ── 31 · Management: ownership, not babysitting ─────────────────────────────
  {
    slug: "mgmt-ownership-not-babysitting",
    title: "Ownership, not babysitting",
    subtitle: "You're not babysitting your department — you're raising it",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Directing is a trust, not a title bump — even when the role is unpaid today, it's rehearsal for what the movement becomes tomorrow. The mission asks for real sacrifice, and it offers something realer back: you get to build something that outlives you.",
      },
      {
        kind: "p",
        text: "The baseline ask is concrete: **at least 5 focused hours a week**, even though everyone directing this is also carrying school, a job, a family, other callings. What's actually being asked for isn't hours — it's ownership. \"You are not babysitting your department — you are raising it.\"",
      },
      {
        kind: "rule",
        title: "The visionary, not the waiting room",
        text: "Leadership offers steering and covering, not a script. The direction of your department is yours: what does excellence look like here, and what does this look like at 10x the size? Own it boldly — you're the one deciding, not the one waiting to be told.",
      },
      {
        kind: "table",
        headers: ["If your department needs…", "Your job is…"],
        rows: [
          ["**40 hrs/week of work**", "Structure a system where that happens — even though you can only give 5 yourself"],
          ["**A rotation, not a soloist**", "Recruit, organize, and structure a team: volunteers, friends, contractors if budget allows"],
          ["**To survive you missing a week**", "Build runbooks and a bench BEFORE you need them, not after"],
        ],
      },
      {
        kind: "p",
        text: "Building for scale looks different by seat, but the shape repeats: a Music Director doesn't plan one set list, they build a rotation and a rehearsal system. A Creative Director doesn't design one flyer, they build a style guide so a chapter three cities away can make ten flyers on-brand without asking. The test is the same everywhere — does it work when you're not in the room?",
      },
      {
        kind: "reveal",
        prompt:
          "Your department needs a weekly task done and you're the only one who knows how. Do it yourself again this week?",
        answer:
          "Once, sure — but treat this week as the last time. Write the runbook while you do it, then hand it off. Doing it yourself solves this week; a system solves every week after it. \"You're not babysitting your department — you're raising it\" means the job is the system, not the task.",
      },
      {
        kind: "p",
        text: "Keep the frame in view: this isn't administration for its own sake. \"Every meeting, every caption, every team you build — it's all worship... You're not just organizing volunteers. You're building altars.\"",
      },
      {
        kind: "tip",
        text: "Further reading — **Director Expectations & Leadership Philosophy**: https://www.notion.so/2197f1c177b680d99fb9e919630ed294",
      },
    ],
    quiz: [
      {
        prompt: "What does the Director role actually ask for, beyond the 5-hour baseline?",
        options: [
          "Nothing more than the hours logged",
          "Ownership — building a department that runs at its real scope, not just covering the baseline yourself",
          "A title and nothing else",
          "Permission before every decision",
        ],
        answerIndex: 1,
        explanation:
          "\"You are not babysitting your department — you are raising it.\" Hours are the floor; ownership of the outcome is the actual ask.",
      },
      {
        prompt: "Your department genuinely needs 40 hours of work a week. What's the doctrine?",
        options: [
          "Work 40 hours yourself, no matter the cost",
          "Structure a system — team, runbooks, delegation — that produces 40 hours of output from your 5",
          "Scale the department down to fit 5 hours",
          "Ask Leadership to do it for you",
        ],
        answerIndex: 1,
        explanation:
          "Build for scale: the 5-hour ask is a floor on your time, not a ceiling on your department's output. The gap is closed by system and team, not by burning yourself out.",
      },
      {
        prompt: "Why does the doctrine call directors \"the visionary of your department\" rather than an executor of instructions?",
        options: [
          "Leadership doesn't care what happens in your area",
          "Leadership offers steering and covering, but the direction is yours to set and own — you're not waiting to be told",
          "Because directors report to no one",
          "It's a courtesy title with no real authority",
        ],
        answerIndex: 1,
        explanation:
          "Ownership cuts both ways: real authority over the vision, and real accountability for the outcome. Neither half is optional.",
      },
      {
        prompt: "A Creative Director builds a font/style guide and templates instead of designing every flyer personally. What is this an example of?",
        options: [
          "Micromanaging the brand",
          "Building for scale — a system that lets any chapter produce on-brand work without the Director in the room",
          "Avoiding the real work",
          "Something only large departments need",
        ],
        answerIndex: 1,
        explanation:
          "The test for build-for-scale is whether the department works when you're absent. Systems and templates are how a 5-hour Director produces a 40-hour department.",
      },
    ],
  },

  // ── 32 · Management: the SLAs ───────────────────────────────────────────────
  {
    slug: "mgmt-the-slas",
    title: "The SLAs",
    subtitle: "30 minutes, same day, two minutes a week — and never a bare no",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Ownership without a clock attached is just a vibe. The Director Operating Standard turns \"stay on top of it\" into service-level agreements — specific, checkable, and the same for every director.",
      },
      {
        kind: "table",
        headers: ["When…", "The standard"],
        rows: [
          ["A project is active", "Acknowledge a leadership message within **30 minutes** — not resolve, acknowledge. \"Got it, thinking\" beats silence."],
          ["A decision is needed", "Resolve it **same-day** whenever possible, or propose a time to decide, or a clear next step"],
          ["Every week, no exceptions", "Send a **2-minute weekly update** — what moved, what's stuck, what you need"],
          ["Something has to be a no", "Never a bare no — offer an alternative, a scheduled discussion, or an honest assessment with a recommendation"],
        ],
      },
      {
        kind: "rule",
        title: "Silence is not acceptable",
        text: "Busy is allowed. Unreachable is not. A director who goes quiet during an active project isn't being humble about needing space — they're making the rest of the team guess, and guessing is expensive.",
      },
      {
        kind: "p",
        text: "\"Closing the loop\" is the SLA underneath the SLAs: whatever the ask, the response is never just a wall. A tired \"no\" that offers nothing back reads as disengagement even from someone who's genuinely swamped — the fix costs one more sentence.",
      },
      {
        kind: "reveal",
        prompt:
          "A leader messages you mid-week needing a decision on a vendor. You're slammed and don't have an answer yet. What's SLA-compliant?",
        answer:
          "Acknowledge within 30 minutes even without the answer: \"Saw this — comparing two options, I'll have a call by Thursday.\" That's not a decision, but it closes the loop: they know you saw it, and when to expect the real answer. Going quiet for two days, even while genuinely working the problem, reads as the SLA breaking.",
      },
      {
        kind: "tip",
        text: "Further reading — **Director Operating Standard (Effective 2026)**, §3: https://www.notion.so/2d87f1c177b680c98426fb999e68b915, and **Director Operating Standards - Shortened**, §1, §3–5: https://www.notion.so/b898b6724eaf4787849bcffa7feb3200.",
      },
    ],
    quiz: [
      {
        prompt: "What's the acknowledgment SLA for a leadership message during an active project?",
        options: [
          "Reply within a week",
          "Acknowledge within 30 minutes — resolving can come later, but silence can't",
          "No SLA — reply when convenient",
          "Only acknowledge if it's urgent",
        ],
        answerIndex: 1,
        explanation:
          "30 minutes is an acknowledgment window, not a resolution window. It exists so nobody wonders whether the message landed.",
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
          "Same-day resolution, or naming a time to decide, or a clear next step — the standard accepts \"not yet, here's when\" as compliant. It doesn't accept silence.",
      },
      {
        prompt: "Why does a 2-minute weekly update exist, given directors already have 1:1s and check-ins?",
        options: [
          "It doesn't — it's redundant with the check-in",
          "It's a fixed weekly pulse on schedule regardless of whether anything dramatic happened, so drift is caught early instead of at the next 1:1",
          "To generate more paperwork",
          "Only underperforming directors send one",
        ],
        answerIndex: 1,
        explanation:
          "The weekly update is a floor cadence, not a status meeting. It's short by design — 2 minutes — specifically so there's no excuse to skip it.",
      },
      {
        prompt: "What makes a response SLA-compliant when the honest answer is \"no\"?",
        options: [
          "Sending the no as fast as possible, nothing else needed",
          "Never saying no, ever",
          "Closing the loop — pairing the no with an alternative, a scheduled discussion, or an assessment with a recommendation",
          "Letting someone else deliver the no",
        ],
        answerIndex: 2,
        explanation:
          "A bare no is treated as a standards violation. The fix is cheap: one more sentence turns a dead end into a next step.",
      },
    ],
  },

  // ── 33 · Management: the repair ritual ──────────────────────────────────────
  {
    slug: "mgmt-the-repair-ritual",
    title: "The repair ritual",
    subtitle: "A missed meeting isn't the failure — an unrepaired one is",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Meetings get missed. Directors are human, carrying real jobs and real families alongside this. The standard doesn't pretend otherwise — it just refuses to let a miss go unrepaired.",
      },
      {
        kind: "rule",
        title: "Apologize, then propose — within 24 hours",
        text: "Missed a meeting? The repair ritual is two moves, both required: apologize, and propose 2-3 alternate times, inside 24 hours. Not \"sorry, my bad\" left hanging — a concrete next step attached to the apology.",
      },
      {
        kind: "p",
        text: "Apology without a proposed time is just a feeling. Proposing times without acknowledging the miss is just logistics. Together, they're what turns a dropped ball into a recovered one — and they're what separates a director who's overwhelmed from one who's disengaging.",
      },
      {
        kind: "p",
        text: "A missed-then-repaired meeting is a non-event — the ritual above handles it. The standard also names what happens when the pattern doesn't break: meetings missed without notice, responses that stay slow or inconsistent, decision ownership avoided, or a director who has to be chased. When that's the real picture, Leadership has tools to reach for — not a script to run in order.",
      },
      {
        kind: "bullets",
        items: [
          "**Adjust reporting structure** — change who the director is accountable to, day to day",
          "**Narrow scope of responsibility** — shrink the role to what's actually being carried well",
          "**A time-bound Performance Improvement Plan** — explicit expectations, with weekly check-ins to evaluate progress",
          "**Redefine the role entirely** — reshape it to fit what's real",
        ],
      },
      {
        kind: "rule",
        title: "Tools, not rungs",
        text: "These four are not a fixed sequence, and there's no \"warning\" step that has to come first — Leadership picks whichever one actually answers the pattern in front of them, or more than one at once. \"These actions are about operational health, not punishment\": the goal is a role and a director that fit each other, not a ladder to climb.",
      },
      {
        kind: "reveal",
        prompt:
          "You missed Thursday's leadership meeting — swamped, no heads-up sent. It's Friday morning. What do you do first?",
        answer:
          "Send the repair message now, inside the 24-hour window: apologize plainly, and offer 2-3 specific times this week to catch up on what you missed. Waiting for someone to ask what happened turns a forgivable miss into the start of a pattern.",
      },
      {
        kind: "tip",
        text: "Further reading — **Director Operating Standard (Effective 2026)**, §4 and §9: https://www.notion.so/2d87f1c177b680c98426fb999e68b915.",
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
          "Either half alone is incomplete — feeling sorry without a next step, or logistics without acknowledgment. The ritual requires both, fast.",
      },
      {
        prompt: "A Director consistently misses meetings without notice, responds slowly, avoids decision ownership, and has to be chased. What does the standard say Leadership can do?",
        options: [
          "Nothing until a full quarter has passed",
          "Reach for whichever tool fits — adjust reporting structure, narrow scope, a time-bound Performance Improvement Plan with weekly check-ins, or redefine the role — as the pattern calls for, not in a required order",
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
          "Because the point is fixing a mismatch between the role and what's really being carried, not penalizing the person",
          "Because only volunteers, never Directors, are subject to them",
          "Because Leadership needs a reason to remove someone",
        ],
        answerIndex: 1,
        explanation:
          "The frame matters: these are structural fixes for a role that's stopped fitting reality, applied deliberately — the same doctrine as fixing the system, not just the person, elsewhere in this stream.",
      },
    ],
  },

  // ── 34 · Management: building for your absence ──────────────────────────────
  {
    slug: "mgmt-building-for-your-absence",
    title: "Building for your absence",
    subtitle: "The 5-hour director, forward pull, and one cross-functional move a week",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Everything in this course points at one test: does your department survive you disappearing for a month? \"Building for your absence\" is that test, made into a weekly practice instead of a hypothetical.",
      },
      {
        kind: "p",
        text: "It starts with the math nobody says out loud: you committed 5 focused hours. Your department needs more than that to actually run. The gap between those two numbers is exactly the size of the system you're supposed to be building — delegation and scale thinking aren't nice-to-haves, they're the only way the math works.",
      },
      {
        kind: "rule",
        title: "Forward pull, not forward drag",
        text: "Proactivity here has a number: **at least 2 proactive leadership actions a week** — moves nobody asked for, that pull the department forward before a gap forces them. A director who only responds to what's asked is being dragged, not leading.",
      },
      {
        kind: "bullets",
        items: [
          "**Cross-project mindset** — your department doesn't sit in isolation; a blocker in someone else's area is still worth flagging, a resource someone else needs is still worth offering.",
          "**At least 1 cross-functional leadership action a week** — a move that helps outside your own lane, on purpose, not by accident.",
          "**The daily availability window** — you don't need to be reachable all day, but you commit to a real window, every day, and crunch weeks flex it wider, not narrower.",
        ],
      },
      {
        kind: "p",
        text: "This is where the two earlier lessons connect: the SLAs are what \"reachable\" means in practice; the repair ritual is what happens when reachability slips once. Building for your absence is the forward-looking version of both — the department that doesn't need you to be reachable at all, because it was built not to.",
      },
      {
        kind: "reveal",
        prompt:
          "You've hit your 5 hours this week just keeping your own duties fulfilled — no time left for anything proactive. Is that a compliant week?",
        answer:
          "No — it's a warning sign, not a pass. 5 hours spent entirely on your own tasks with zero proactive or cross-functional moves means the department is still running on you personally, not on a system. The standard isn't just time spent; it's time spent building the thing that runs without you.",
      },
      {
        kind: "tip",
        text: "Further reading — **Director Expectations & Leadership Philosophy**: https://www.notion.so/2197f1c177b680d99fb9e919630ed294, **Director Operating Standard (Effective 2026)**, §2, §6, §8: https://www.notion.so/2d87f1c177b680c98426fb999e68b915, and **Director Operating Standards - Shortened**, §3, §6: https://www.notion.so/b898b6724eaf4787849bcffa7feb3200.",
      },
    ],
    quiz: [
      {
        prompt: "What does \"building for your absence\" actually test?",
        options: [
          "How many hours you personally log",
          "Whether the department keeps running if you're gone for a month — the system, not the person, is what's being evaluated",
          "Whether you've hired a replacement",
          "How well you delegate paperwork",
        ],
        answerIndex: 1,
        explanation:
          "It's the same absence test used elsewhere in the stream, applied to an entire department: every duty covered, every gap visible, without you in the room.",
      },
      {
        prompt: "What does \"forward pull\" require, concretely?",
        options: [
          "Waiting for Leadership to assign tasks",
          "At least 2 proactive leadership actions a week — moves nobody asked for that push the department ahead of a gap",
          "One action a year at review time",
          "Nothing — reacting quickly is enough",
        ],
        answerIndex: 1,
        explanation:
          "Forward pull has a number attached on purpose: a director who's only ever responding to requests isn't leading, they're keeping pace.",
      },
      {
        prompt: "A director spends their entire 5 hours firefighting their own duties, week after week, with no proactive or cross-functional moves. What does the standard say?",
        options: [
          "That's a fully compliant week — the hours were logged",
          "It's a warning sign: time spent is not the same as building capacity that survives your absence",
          "It means the department needs fewer duties",
          "It only matters if a leadership message goes unanswered",
        ],
        answerIndex: 1,
        explanation:
          "Logging hours on your own tasks and building a department that runs without you are different activities. The forward-pull requirement exists so the second one doesn't get skipped.",
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
    subtitle: "Faithfulness before position — titles follow fruit",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Recruiting here doesn't start with a job posting — it starts with a mindset. \"We empower people to do the work before giving them a title.\" Everyone, from a first-time volunteer to a future director, serves through the same trial before the title arrives. Faithfulness before position: titles follow fruit.",
      },
      {
        kind: "p",
        text: "Public Worship is early-stage, which changes who you're looking for. This isn't hiring for a fixed slot — it's building a foundational team, so even a small role should carry **director-level potential**: initiative, clear communication, ownership, people skills. \"We are building founders, not just volunteers.\"",
      },
      {
        kind: "rule",
        title: "The specialist exception",
        text: "Strong individual contributors — video editors, designers, engineers — are the deliberate exception. Depth in a craft is the qualification; director-level potential is a bonus, not a gate. Don't force every hire through the same founder-shaped mold.",
      },
      {
        kind: "p",
        text: "\"Every person passes through the same door\" — the five-step pipeline is identical whether the candidate is a friend, a stranger who filled out a public interest form, or someone already serving informally:",
      },
      {
        kind: "table",
        headers: ["Step", "What happens"],
        rows: [
          ["**1 · Create the role**", "Define it before you go looking — purpose, responsibilities, ideal candidate traits"],
          ["**2 · Find candidates, in order**", "In-house → volunteer interest pool → public call/interest form → personal networks — always in that order, never skipping to \"who do I know\""],
          ["**3 · Interview**", "At least two team members, one shared rubric — see the next lesson"],
          ["**4 · Empowerment Trial**", "1–2 months of real, bounded work before anything is official"],
          ["**5 · The Director decides**", "Final say, made prayerfully — and a templated outcome message either way"],
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A friend of a team member wants a role, and they seem like a great personal fit. Can they skip straight to an offer?",
        answer:
          "No — same door as everyone else. They still go through the ordered candidate search, the shared-rubric interview, and the Empowerment Trial. Skipping steps for a known quantity is exactly the shortcut the pipeline exists to prevent — fit gets confirmed in practice, not assumed from familiarity.",
      },
      {
        kind: "tip",
        text: "Further reading — **Recruitment Philosophy & Mindset**: https://www.notion.so/aedcbb918d394a31bb9b36df8e1683a1. The five-step pipeline is reconstructed from a verified crawl summary of the \"Adding Someone to the Team\" hub page (captured 2026-07-17 after it went private) — flagged for an owner spot-check: https://www.notion.so/af1344859be446d38b40c708834409f9.",
      },
    ],
    quiz: [
      {
        prompt: "What does \"Faithfulness before position\" mean in practice?",
        options: [
          "Titles are given up front to attract candidates",
          "Nobody gets a title until they've proven fit through real work — the title follows demonstrated fruit, not the other way around",
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
          "It shouldn't — small roles need less",
          "Because the team is being built as a foundational, founder-generation team in an early-stage organization — with an explicit exception for specialists",
          "Titles are handed out regardless of potential",
          "Only true for roles based in one city",
        ],
        answerIndex: 1,
        explanation:
          "This is a startup-stage bias, not a permanent rule for every role forever — and it explicitly carves out strong individual contributors as the exception.",
      },
      {
        prompt: "What order does the candidate search follow, and why does the order matter?",
        options: [
          "Personal networks first, since trust is already established",
          "In-house, then the volunteer interest pool, then a public call, then personal networks — in that order, so every candidate passes through the same door",
          "Whatever order is fastest each time",
          "Public call only — no other sources allowed",
        ],
        answerIndex: 1,
        explanation:
          "\"Every person passes through the same door\" is the point: the fixed order stops personal connections from becoming a silent shortcut around the process.",
      },
      {
        prompt: "What's the deliberate exception to the founder-potential bias?",
        options: [
          "There is no exception",
          "Specialists / strong individual contributors — e.g. video editors, designers, engineers — are chosen primarily for craft depth",
          "Directors are exempt from screening",
          "Volunteers under 25",
        ],
        answerIndex: 1,
        explanation:
          "The bias toward broad founder potential fits generalist and leadership roles; it's explicitly relaxed for roles where deep craft skill is the actual job.",
      },
    ],
  },

  // ── 36 · Management: the interview ──────────────────────────────────────────
  {
    slug: "mgmt-the-interview",
    title: "The interview",
    subtitle: "Two meetings, one covering question, and a rubric that ranks character first",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "\"Every interview is an encounter. We're not just evaluating people — we're inviting them into something sacred.\" That framing matters because it's easy to run an interview like a transaction; the structure here is built to be a two-way, honest conversation instead.",
      },
      {
        kind: "table",
        headers: ["Meeting", "Focus"],
        rows: [
          ["**1 · Heart & Alignment** (20–30 min)", "Their story, why they want to serve, chemistry, communication, humility, and sharing the mission plainly"],
          ["**2 · Role Fit** (20 min, optional)", "Role-specific depth, scope, and the Empowerment Trial — combine with Meeting 1 if time is short"],
        ],
      },
      {
        kind: "rule",
        title: "Availability isn't a soft question — it's a gate",
        text: "Ask time commitment early, honestly, for everyone: roughly 10 hrs/week for directors, 5 for team members, plus recurring meeting attendance. If the time genuinely doesn't work, it's a non-starter — no matter how strong the candidate is otherwise.",
      },
      {
        kind: "p",
        text: "The **spiritual covering** question is asked of everyone, plainly: where do you call home church, how are you attending and giving there, what's drawing you here specifically? The screen isn't about gatekeeping faith — it's a specific concern, stated openly: \"we want people who are already spiritually covered... not looking to make Public Worship their church.\"",
      },
      {
        kind: "p",
        text: "When two candidates are close, the rubric breaks the tie in a fixed order, deliberately: **character**, then **communication**, then **people skills**, then **execution**, then **availability**. \"Skill can be trained; heart can't\" is the whole rationale for that order — and it's the same rubric the Empowerment Trial re-uses to confirm the call in practice.",
      },
      {
        kind: "reveal",
        prompt:
          "A candidate is clearly the most technically skilled applicant, but their answers about handling feedback and team tension are vague and defensive. Character or execution — which wins?",
        answer:
          "Character wins the tiebreak. The rubric ranks it first for a reason: technical execution is trainable inside the Empowerment Trial; how someone actually handles correction and tension under a real team usually isn't visible until it's tested — and that's exactly what the trial is for. A strong-skill, weak-character signal is a flag to slow down, not to fast-track.",
      },
      {
        kind: "tip",
        text: "Further reading — **Interview Guide**: https://www.notion.so/fd030aac3b66443a946111b2d98f200e.",
      },
    ],
    quiz: [
      {
        prompt: "What's the purpose of Meeting 1 (Heart & Alignment)?",
        options: [
          "Testing role-specific technical skill in depth",
          "Understanding who they are and why they want to serve — chemistry, communication, humility — and sharing the mission plainly",
          "Negotiating their start date",
          "Reviewing their resume line by line",
        ],
        answerIndex: 1,
        explanation:
          "Meeting 1 is about the person and alignment; role-specific depth is Meeting 2's job (or the same conversation, combined, if time is short).",
      },
      {
        prompt: "Why is availability confirmed early and treated as a hard gate?",
        options: [
          "It isn't a gate — commitment is negotiable later",
          "Because if the realistic time commitment doesn't work, no amount of talent changes that it's a non-starter — better to know before investing further",
          "Only directors need to answer it",
          "It's asked last, after the offer",
        ],
        answerIndex: 1,
        explanation:
          "The guide is explicit: confirm capacity early, for everyone — a strong candidate with no real time available is still a no.",
      },
      {
        prompt: "What is the spiritual covering question actually screening for?",
        options: [
          "Whether the candidate shares the team's exact denomination",
          "Whether the candidate is already planted, attending, and giving at their own home church — not looking to make this organization their church home",
          "Whether the candidate has ever attended church",
          "Nothing — it's a formality",
        ],
        answerIndex: 1,
        explanation:
          "The stated concern is explicit and specific: people should be spiritually covered elsewhere, so their serving here is an overflow of that, not a substitute for it.",
      },
      {
        prompt: "In what order does the rubric rank candidates when choosing between close options?",
        options: [
          "Execution, then availability, then character",
          "Character, then communication, then people skills, then execution, then availability",
          "Availability first — time commitment trumps everything else",
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
        text: "The interview tells you what someone says about themselves. The Empowerment Trial tells you what's true: 1–2 months of real, bounded work, done before anything is made official — \"it confirms fit in practice and lets them experience our culture from day one.\"",
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
        text: "The trial deliberately gives real work, not busywork — design mockups, outlines, event plans, concept pitches. It just as deliberately withholds anything hard to walk back: no posting to official accounts, no managing budgets, no handling sensitive data. And the candidate isn't added to Slack yet — they're connected only to the minimum people needed to do the assigned work.",
      },
      {
        kind: "p",
        text: "The rubric doesn't change for the trial — it's the same one from the interview: communication and response time, people skills and relational grace, initiative and follow-through, excellence and ownership, alignment with mission. More than one person can complete a midpoint or final review before a decision gets made, so the read isn't riding on a single impression.",
      },
      {
        kind: "reveal",
        prompt:
          "Midway through a Director-track trial, the candidate asks to be added to Slack so they can \"get a head start\" on team culture. What do you say?",
        answer:
          "Not yet — that's the boundary working as intended. The trial connects them only to the people needed for their assigned work; broader access waits for the official decision at the two-month mark. Saying so plainly (\"that's part of what comes after the decision, not before\") is kinder than a vague stall — it's a boundary, not a slight.",
      },
      {
        kind: "tip",
        text: "Further reading — **Empowerment Trial**: https://www.notion.so/bde60f9c5c8f4262a56f9b0204ce4862.",
      },
    ],
    quiz: [
      {
        prompt: "What is the Empowerment Trial for?",
        options: [
          "A formality before an already-made decision",
          "Confirming fit IN PRACTICE — real work, evaluated on the same rubric as the interview, before anything is made official",
          "Free labor before paying someone",
          "Testing only technical skill",
        ],
        answerIndex: 1,
        explanation:
          "It exists specifically to test what an interview can't: how someone actually performs and behaves inside real, if bounded, work.",
      },
      {
        prompt: "What's explicitly OFF-LIMITS during the trial?",
        options: [
          "Design mockups and concept pitches",
          "Posting to official accounts, managing budgets, or handling sensitive data — and Slack access, until the decision is made",
          "Attending check-ins",
          "Working on event plans",
        ],
        answerIndex: 1,
        explanation:
          "The trial empowers real work while withholding anything hard to walk back — that boundary is deliberate, not an oversight.",
      },
      {
        prompt: "How does the check-in cadence differ between a Team Member and a Director trial?",
        options: [
          "They're identical",
          "Team Member: midpoint at 2 weeks, decision at 4 weeks. Director: midpoint at 1 month, decision at 2 months — directors get a longer runway given the larger role",
          "Directors skip the trial entirely",
          "Team Members get twice as long as Directors",
        ],
        answerIndex: 1,
        explanation:
          "The longer director track reflects the bigger scope being confirmed — more time to demonstrate ownership and initiative at that altitude.",
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
        text: "Everything before this — the pipeline, the interview, the trial — exists to inform one decision, not replace it. \"The Director has the final say — this process supports their prayerful decision; it doesn't replace it.\" The rubric and the trial are evidence; the call is still a judgment made by a person, carrying real weight.",
      },
      {
        kind: "p",
        text: "Whichever way the decision goes, the candidate hears it the same way: a templated outcome message, sent promptly, that matches the moment instead of leaving them guessing.",
      },
      {
        kind: "table",
        headers: ["Outcome", "What the message does"],
        rows: [
          ["**Acceptance**", "Names the empowerment plainly — \"we're excited to empower you to lead in this area\" — and moves straight into what's next"],
          ["**Warm rejection**", "Stays genuinely warm, not a form-letter brush-off — \"we've been talking with a few people... would love to stay connected\" keeps the door open instead of slamming it"],
        ],
      },
      {
        kind: "rule",
        title: "The warm no is doctrine, not politeness",
        text: "A candidate who wasn't chosen still gave real time to a real trial. A cold, silent, or delayed no undoes the goodwill the whole empowerment-first pipeline was built to create. The templated warm rejection exists because how you say no is as much a part of the culture as how you say yes.",
      },
      {
        kind: "p",
        text: "\"Skill can be trained — spirit can't\" closes the loop on the whole course: the pipeline spends most of its effort screening for character, alignment, and fit precisely because that's the part that can't be taught later. Everything trainable — a specific skill, a workflow, a tool — gets taught inside the role, after the call is made.",
      },
      {
        kind: "reveal",
        prompt:
          "The trial went well on paper, but the Director has a quiet, hard-to-articulate hesitation about fit. What should drive the decision?",
        answer:
          "The Director's prayerful judgment, including the hesitation — the process supports the decision, it doesn't replace it. A vague unease that survives a full trial and interview is itself data worth weighing, not something to override just because the checklist looks complete. And if the answer is no, it still gets delivered warmly, on the same template as any other no.",
      },
      {
        kind: "tip",
        text: "Further reading — **Outcome Messages**: https://www.notion.so/926362a032d143d6b1a3a7847187acf8 and the \"Adding Someone to the Team\" hub: https://www.notion.so/af1344859be446d38b40c708834409f9. Both pages went private before they could be archived; this lesson is built from verified crawl summaries captured 2026-07-17 — flagged for an owner spot-check.",
      },
    ],
    quiz: [
      {
        prompt: "Who makes the final hiring decision, and what role does the rubric/trial play?",
        options: [
          "The rubric score alone decides automatically",
          "The Director decides, prayerfully — the interview rubric and trial inform that judgment, they don't replace it",
          "A committee vote",
          "Whoever ran the interview",
        ],
        answerIndex: 1,
        explanation:
          "Process supports the decision; it isn't a substitute for it. The Director's judgment is the actual mechanism.",
      },
      {
        prompt: "Why does a declined candidate still get a warm, templated message instead of silence?",
        options: [
          "It's just a courtesy with no real purpose",
          "Because they gave real time to a real trial, and a cold or absent no undermines the trust the whole empower-first approach depends on",
          "Warm rejections are legally required",
          "Only accepted candidates get a message",
        ],
        answerIndex: 1,
        explanation:
          "The warm no is treated as part of the culture, not an afterthought — a templated, genuinely warm rejection keeps the relationship and the door open.",
      },
      {
        prompt: "What does \"Skill can be trained — spirit can't\" explain about the whole pipeline?",
        options: [
          "That skills don't matter at all",
          "Why the process spends most of its screening effort on character and alignment — the untrainable part — while trainable skill gets taught after the call",
          "That spiritual maturity is graded numerically",
          "That the trial is only about technical output",
        ],
        answerIndex: 1,
        explanation:
          "It's the rationale behind every earlier rubric ranking (character first) and behind trusting the trial over a resume — untrainable qualities get screened up front.",
      },
    ],
  },

  // ── 39 · Management: the four gates ─────────────────────────────────────────
  {
    slug: "mgmt-the-four-gates",
    title: "The four gates",
    subtitle: "Faith, mission, the ask, and the brand — clear all four or it's a no",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Partnership requests — sponsorships, cross-promo, collabs, someone wanting to piggyback on an event — need a decision, and they need it fast enough not to waste anyone's momentum. The four gates are a lightweight, repeatable filter built for exactly that: fast where it can be, careful where it must be.",
      },
      {
        kind: "table",
        headers: ["Gate", "The question"],
        rows: [
          ["**1 · Faith & beliefs**", "Does the organizer and project align with our faith and statement of beliefs? **Non-negotiable** — any conflict here is a decline regardless of the upside."],
          ["**2 · Mission fit**", "Does this serve the actual mission? If the fit isn't obvious, ask the partner for a written justification rather than guessing on their behalf."],
          ["**3 · The ask + director buy-in**", "What's actually being requested — infrastructure, a social post, cash, people? — and does the director who owns that resource agree?"],
          ["**4 · Brand exposure & trust**", "How exposed is the brand, and can we vouch for the other side? \"No accidental Ponzi schemes\" — a credibility check beats a regretted cosign."],
        ],
      },
      {
        kind: "rule",
        title: "A hard fail on any gate ends it there",
        text: "The gates run in order, and a hard fail on Gate 1 doesn't get argued back to life by a strong Gate 4. \"We don't steer from the main plot — even if people are asking for it.\" Clearing all four is the bar; clearing three well isn't a partial-credit system.",
      },
      {
        kind: "p",
        text: "Gate 3 is where good-sounding partnerships quietly die, and that's by design: a partner wanting a shoutout the same week you're promoting your own event is a real conflict, and the Marketing Director saying no to protect that is a *valid* no — not an obstacle to route around.",
      },
      {
        kind: "reveal",
        prompt:
          "A well-known, well-funded organization wants to co-brand an event with you next month. Their beliefs statement doesn't obviously conflict with yours, but it's vague and you can't quite tell.",
        answer:
          "Gate 1 doesn't get waved through on vagueness — ask directly, and if real ambiguity remains after asking, that ambiguity itself is the answer: slow down rather than assume alignment because the partner is prominent or well-funded. Size and funding are Gate-4 considerations at best; they say nothing about Gate 1.",
      },
      {
        kind: "tip",
        text: "Further reading — **SOP: Partnership Evaluation Process**: https://www.notion.so/ded2e9ae50cf4e779ae7423e7daaa10b.",
      },
    ],
    quiz: [
      {
        prompt: "What happens when a partnership request hard-fails Gate 1 (faith & beliefs)?",
        options: [
          "It moves on to Gate 2 for a second opinion",
          "It's declined regardless of any upside on the other gates — Gate 1 is explicitly non-negotiable",
          "It gets approved with conditions",
          "Only the ED can override it",
        ],
        answerIndex: 1,
        explanation:
          "Gate 1 isn't weighed against the others — a conflict there ends the evaluation on its own, full stop.",
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
          "Ambiguity at Gate 2 has a specific move: ask, don't assume. A written justification turns a guess into an actual answer.",
      },
      {
        prompt: "Why can a Marketing Director's \"no\" to a request for a social shoutout be valid, even if the partnership otherwise looks appealing?",
        options: [
          "Marketing Directors can veto anything for any reason",
          "Gate 3 requires buy-in from whichever director owns the specific resource being asked for — a real conflict is a legitimate reason to decline that resource",
          "Marketing is the only gate that matters",
          "Social posts never require sign-off",
        ],
        answerIndex: 1,
        explanation:
          "The gate ties sign-off to the actual resource requested. A conflict (e.g. competing with your own event promo) is exactly the kind of thing Gate 3 exists to catch.",
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
        text: "The four gates tell you *what* to check. This is the doctrine for *who* gets to decide — and it's asymmetric on purpose: \"The frontline can always say no. Only the ED says the final yes.\"",
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
        text: "The routing table isn't a courtesy CC — it's a gate. If the director who owns the specific resource being asked for doesn't sign off, the partnership doesn't happen, no matter how enthusiastic the frontline or the ED are about the rest of it.",
      },
      {
        kind: "p",
        text: "The asymmetry is the whole design: any single person in the flow can end a bad partnership early — the frontline screening it, or a director declining their piece — without needing anyone else's agreement first. But turning a good partnership on requires the full chain: frontline clearance, the specific director's sign-off, AND the ED's rubber stamp. Declining is cheap and fast; approving is deliberately not.",
      },
      {
        kind: "p",
        text: "This ownership model — one person can always kill it, only the top role can green-light it — travels well beyond partnerships. It's the same shape as any chapter-level decision about committing someone else's resource: reusable verbatim, whatever the chapter and whatever's being asked.",
      },
      {
        kind: "reveal",
        prompt:
          "The frontline is excited about a partnership and the affected director hasn't responded yet. The ED is asking for a quick answer. Can the frontline give a provisional yes to keep momentum?",
        answer:
          "No — the flow has no provisional-yes state. Without the affected director's sign-off, the honest answer is \"not yet,\" not a soft yes that gets walked back later. Momentum doesn't override the routing table; the frontline can offer to follow up with a firm timeline instead of promising an outcome nobody has actually approved.",
      },
      {
        kind: "tip",
        text: "Further reading — **SOP: Partnership Evaluation Process**: https://www.notion.so/ded2e9ae50cf4e779ae7423e7daaa10b.",
      },
    ],
    quiz: [
      {
        prompt: "Who has the authority to decline a partnership request outright?",
        options: [
          "Only the Executive Director",
          "The frontline can always say no — declining doesn't require anyone else's agreement",
          "Only the affected director",
          "Nobody — every request must go to a full review",
        ],
        answerIndex: 1,
        explanation:
          "The asymmetry is deliberate: any no can happen fast and alone. Only a yes needs the full chain.",
      },
      {
        prompt: "A partner wants both a social post and event infrastructure. Whose sign-off is required?",
        options: [
          "Only the Partnerships Director's",
          "Both the Marketing & Creative Director AND the Events & Production Director — each resource routes to the director who owns it",
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
          "Nothing — director sign-off is sufficient on its own",
        ],
        answerIndex: 1,
        explanation:
          "\"Only the ED says the final yes\" — frontline clearance and director buy-in are necessary but not sufficient; the ED's stamp is the last, non-skippable gate.",
      },
    ],
  },
];

/** The Management stream's theme entry. */
export const MANAGEMENT_THEME: Theme = {
  key: "management",
  title: "People & Leadership",
  subtitle:
    "Lead the people: 1:1s, delegation, care that still holds the line — " +
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
      "work — and feedback that travels up the chain.",
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
      "Caring for people while holding the line: load, rotation, gratitude — " +
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
      "What Directors are actually held to: ownership over babysitting, " +
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
      "Empower first, appoint second: the five-step hiring pipeline, the " +
      "interview rubric, the Empowerment Trial, and the call that ends it " +
      "— kindly, either way.",
    icon: "user-plus",
    moduleSlugs: [
      "mgmt-empower-first",
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
