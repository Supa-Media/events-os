/**
 * The Management stream — leading the people who do the events + works work:
 * 1:1s, care + accountability, and directing. Also the Management theme + its
 * three courses.
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
];

/** The Management stream's theme entry. */
export const MANAGEMENT_THEME: Theme = {
  key: "management",
  title: "Management",
  subtitle:
    "Lead the people: 1:1s, delegation, and care that still holds the line.",
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
];
