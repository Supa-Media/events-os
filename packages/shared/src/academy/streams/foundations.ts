/**
 * The Foundations stream — who Public Worship is, before how Chapter OS
 * works. Two courses: the mission/org/teams orientation every new teammate
 * needs first ("Welcome to Public Worship"), and the everyday culture that
 * makes the rest of it work ("How we work" — communication, attendance,
 * where information lives, and the posture behind spending). Placed FIRST
 * in the curriculum and catalog — everything else in the Academy assumes a
 * reader who already has this context.
 *
 * Authored from the Public Worship Notion archive (mission/vision, the
 * onboarding guide, the Project Lead role, the attendance policy) and
 * `packages/shared/src/seats.ts` (the org-chart seat taxonomy — SEAT_DEFS).
 * Personnel are never hardcoded here: who holds a seat changes, so every
 * lesson that touches the org chart points the reader to the live Org Chart
 * tab instead of naming names.
 *
 * Owned exclusively by this file for content authoring — do not add
 * Foundations sections or courses anywhere else. See `../index` for how
 * this assembles into the full curriculum/catalog.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Foundations-stream sections, in curriculum order. */
export const FOUNDATIONS_SECTIONS: Omit<AcademySection, "order">[] = [
  // ── 1 · Seeds & soil ────────────────────────────────────────────────────────
  {
    slug: "foundations-seeds-and-soil",
    title: "Seeds & soil",
    subtitle: "The parable behind every gathering",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Before you learn how anything in this app works, know why it exists. Public Worship's mission: to create a holy experience through music — one that ignites unwavering faith in Jesus.",
      },
      {
        kind: "rule",
        title: "Seeds from rocky ground into good soil",
        text: "We strive to move seeds from rocky ground into good soil, to produce fruits of genuine worship that reflect our bold identity in Christ (Matthew 13:4-9).",
      },
      { kind: "heading", text: "The parable, and what it means for us" },
      {
        kind: "p",
        text: "In the parable of the sower, the same seed lands on a path, on rocky ground, among thorns, and on good soil — and only one of those produces a harvest. The seed doesn't change; the ground does. That's the whole theory behind going to strangers in a park instead of only gathering the already-convinced: you can't tell which ground someone is standing on from the outside, so you go and worship anyway, and let the soil reveal itself.",
      },
      {
        kind: "bullets",
        items: [
          "**The mission is the soil work.** Every event, song, and post exists to move someone's ground — including your own — a little closer to good soil.",
          "**Strangers aren't the audience for a show.** They're exactly who the parable is about — the point of Worship With Strangers is standing in public, rocky-ground included, and worshiping anyway.",
          "**\"Genuine worship\" is the fruit, not the event.** A gathering can look and sound perfect and still not be this — the standard is whether it moves someone's ground, not whether the set list landed.",
        ],
      },
      { kind: "heading", text: "Vision" },
      {
        kind: "p",
        text: "To see public worship in every corner of the world, where communities gather to experience and host the presence of Jesus — inspiring a global movement of worship that awakens hearts and reveals God's Kingdom.",
      },
      {
        kind: "p",
        text: "Everything downstream of this lesson — chapters, seats, teams, the whole app — is infrastructure for that one sentence. When a rule in a later lesson feels like process for its own sake, this is the test to run it against: does it help move a seed into good soil, or is it just process?",
      },
      {
        kind: "reveal",
        prompt:
          "A stranger stops mid-set at a park event, unsure if they even belong there. What does the mission say to do?",
        answer:
          "Welcome them in, exactly as they are. You have no way of knowing whether they're standing on the path, on rocky ground, or on good soil — the mission isn't to filter for the convinced, it's to worship in public and let anyone stumble into good ground. Turning inward toward the people who already know the songs is the opposite of the point.",
      },
      {
        kind: "tip",
        text: 'Further reading: "Mission and Vision statements" — https://www.notion.so/f759aafc092441409d189c0a5239cfdd',
      },
    ],
    quiz: [
      {
        prompt: "What is Public Worship's mission?",
        options: [
          "To book the best worship musicians in every city",
          "To create a holy experience through music that ignites unwavering faith in Jesus",
          "To grow the largest social media following of any worship ministry",
          "To fund local churches through ticketed concerts",
        ],
        answerIndex: 1,
        explanation:
          "The mission is about the holy experience and the faith it ignites — everything else (events, music, marketing) exists in service of that one sentence.",
      },
      {
        prompt:
          "In the parable of the sower, what actually differs between the path, the rocky ground, and the good soil?",
        options: [
          "The seed — different seeds are needed for different ground",
          "Nothing differs; the parable is only about farming",
          "The ground — the same seed either fails or produces fruit depending on where it lands",
          "The timing of when the seed is planted",
        ],
        answerIndex: 2,
        explanation:
          "Same seed, different ground, different outcome. That's why the mission talks about moving seeds INTO good soil rather than finding better seeds — the work is on the ground, not the message.",
      },
      {
        prompt: "What is Public Worship's vision?",
        options: [
          "A single flagship worship venue in New York City",
          "Public worship in every corner of the world — a global movement that awakens hearts and reveals God's Kingdom",
          "A streaming platform for worship music",
          "A network of private worship retreats",
        ],
        answerIndex: 1,
        explanation:
          "The vision is global and public on purpose: worship happening in every corner of the world, not confined to a building or a members-only room.",
      },
      {
        prompt:
          "Why does Public Worship worship in public — parks, plazas, train stations — instead of only inside a gathered, already-convinced room?",
        options: [
          "It's cheaper than renting a venue",
          "You can't tell from the outside whose ground is rocky and whose is good, so you go worship where the strangers already are",
          "Public spaces have better acoustics",
          "It's required for the non-profit's tax status",
        ],
        answerIndex: 1,
        explanation:
          "The parable is the reason: since you can't see which ground a stranger is standing on, the mission means showing up and worshiping in public, where the soil gets a chance to reveal itself.",
      },
    ],
  },

  // ── 2 · Chapters and central ────────────────────────────────────────────────
  {
    slug: "foundations-chapters-and-central",
    title: "Chapters and central",
    subtitle: "Seats, not titles",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Public Worship isn't one flat team — it's chapters (one per city) connected to a central org that supports all of them. The shape of both is the same idea drawn twice: an org chart made of seats, not people.",
      },
      { kind: "heading", text: "Two charts, one shape" },
      {
        kind: "table",
        headers: ["Chart", "Root seat", "Seats under it"],
        rows: [
          [
            "**Central** — the org, org-wide",
            "Executive Director",
            "Financial Manager, Development Director, Music Director, Marketing Director, Expansion Director",
          ],
          [
            "**Chapter** — stamped onto every chapter",
            "Chapter Director",
            "Treasurer, Event Lead, Music Lead, Marketing Lead",
          ],
        ],
      },
      {
        kind: "p",
        text: "Every chapter gets its own copy of the same chapter chart — same seats, same shape, different city. Central is the one chart that isn't duplicated: there's only one Executive Director and one Financial Manager for the whole org.",
      },
      {
        kind: "rule",
        title: "Seats, not titles",
        text: "Duties and powers are stamped on the SEAT, not on whoever currently sits in it. The Executive Director seat carries org strategy and the central budget; the Treasurer seat carries recording and reconciling chapter money — and that's true no matter who holds either one this year.",
      },
      {
        kind: "bullets",
        items: [
          "**Everyone can see the whole chart.** The Org Chart tab shows both the central chart and every chapter's chart — it's not leadership-only information.",
          "**Seat changes are two-party.** Anyone can propose a new holder for a seat, but it takes the seat's current holder (or the seat above it) to confirm the change — never a unilateral edit.",
          "**Vacancy is normal, and visible.** An empty seat shows up as empty on the chart. It doesn't get hidden, and it doesn't get silently auto-filled.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You need to know who approves your chapter's budget this month, but you've never met your Chapter Director. Where do you look?",
        answer:
          "Open the Org Chart tab and find the Chapter Director seat for your chapter — it shows exactly who holds it right now, or that it's vacant. Never guess from an old group chat or last year's memory; seats change hands, and the chart is what stays current.",
      },
      {
        kind: "tip",
        text: "In the app: the Org Chart tab is the live source of truth for who holds every seat — this lesson teaches the SHAPE of the chart, not today's names. Look those up, don't memorize them.",
      },
    ],
    quiz: [
      {
        prompt: "How many org charts does Public Worship have?",
        options: [
          "One combined chart for everyone",
          "Two: a central chart (the org) and a chapter chart, stamped onto every chapter",
          "One chart per team (Events, Music, Marketing, Development)",
          "None — Public Worship has no formal structure",
        ],
        answerIndex: 1,
        explanation:
          "Central is org-wide and exists once. Every chapter gets its own copy of the same chapter chart — same seats and shape, one instance per city.",
      },
      {
        prompt: "What actually carries a role's duties and powers — the seat, or the person?",
        options: [
          "The person's seniority or how long they've been around",
          "The seat itself — duties and powers are stamped on the seat, and whoever holds it inherits exactly that job",
          "Whichever team the person originally joined",
          "Nothing is defined until a dispute comes up",
        ],
        answerIndex: 1,
        explanation:
          "Seats, not titles: a seat's job stays the same across every person who ever holds it, which is why 'who does X' is always answerable from the chart, not from memory.",
      },
      {
        prompt: "Who can see the full org chart — both central and chapter?",
        options: [
          "Only Directors and above",
          "Everyone — the Org Chart tab is visible to the whole team",
          "Only whoever the chart is currently about",
          "Only the Executive Director",
        ],
        answerIndex: 1,
        explanation:
          "The chart is deliberately not leadership-only information — anyone can open it and see the whole shape of the org, central and chapter alike.",
      },
      {
        prompt: "How does a seat get a new holder?",
        options: [
          "Whoever wants the seat can just take it",
          "A two-party proposal: someone proposes a holder, and the seat's current holder or the seat above it confirms",
          "Central assigns every seat, chapter and central alike, with no local input",
          "Seats are inherited automatically by tenure",
        ],
        answerIndex: 1,
        explanation:
          "It's a handoff, not a unilateral edit — a proposal plus a confirmation from the right person, which is also why vacancy is normal: nobody gets stuffed into a seat just to fill it.",
      },
    ],
  },

  // ── 3 · The work ─────────────────────────────────────────────────────────────
  {
    slug: "foundations-the-work",
    title: "The work",
    subtitle: "Four teams, and the projects that cross them",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Public Worship's ongoing work sits inside four teams. Each is led by a Director who reports to the Executive Director, and each keeps a different part of the mission moving, every week, whether or not a specific project is underway.",
      },
      {
        kind: "table",
        headers: ["Team", "What it does", "Where you'll see it"],
        rows: [
          [
            "**Events**",
            "Keeps the gatherings running — systems, timelines, task management",
            "Worship With Strangers (parks, train stations, plazas — about once a month) and the quarterly flagship gatherings like Eden and Love Thy Neighbor",
          ],
          [
            "**Music**",
            "Crafts the sound and spiritual atmosphere of our gatherings",
            "Weekly studio sessions, songwriting, and recorded collaborations with artists and producers",
          ],
          [
            "**Marketing & Media**",
            "Tells our story and invites people in",
            "Social presence, content, and the assets that turn a stranger into someone who shows up",
          ],
          [
            "**Development & Partnerships**",
            "Builds the relationships and funding that sustain the mission",
            "Backer relationships and the frontline contact with outside organizations and partners",
          ],
        ],
      },
      { kind: "heading", text: "Projects pull across teams" },
      {
        kind: "p",
        text: "Not everything is a team's standing job. Some things are projects — a worship night, a video series, a campaign — with a start and an end. Projects get a Project Lead instead of a team, and anyone can be one: a team Director, or someone who just got here.",
      },
      {
        kind: "rule",
        title: "Not doing everything — ensuring everything gets done",
        text: "A Project Lead's job isn't to personally execute every task. It's to own the timeline and the communication, pull in whoever the project actually needs from any team, and make sure the finished thing meets the standard Public Worship holds itself to.",
      },
      {
        kind: "reveal",
        prompt:
          "You're on the Music team. The Project Lead for a fall flyer campaign asks you to help write social copy. Is that yours to say yes to?",
        answer:
          "Yes — projects are built to cross teams on purpose. A Project Lead pulls whoever the work needs, regardless of which team's channel you usually sit in. Your team is your home base, not a fence around what you're allowed to help with.",
      },
      {
        kind: "tip",
        text: 'Further reading: "Onboarding – All Public Worship" — https://www.notion.so/2227f1c177b680998edce655167fdab4, and "Project Lead" — https://www.notion.so/2197f1c177b680b2afdfe2b56ce6298b',
      },
    ],
    quiz: [
      {
        prompt: "Which team runs Worship With Strangers and the quarterly flagship gatherings?",
        options: ["Music", "Events", "Marketing & Media", "Development & Partnerships"],
        answerIndex: 1,
        explanation:
          "Events keeps the gatherings running — systems, timelines, and task management for both the monthly park events and the quarterly flagships like Eden.",
      },
      {
        prompt: "What's the Music team's ongoing rhythm?",
        options: [
          "A once-a-year recording retreat",
          "Weekly studio sessions, songwriting, and recorded collaborations",
          "It only activates during quarterly events",
          "Reviewing setlists submitted by outside churches",
        ],
        answerIndex: 1,
        explanation:
          "Music is a standing, weekly rhythm — studio sessions and songwriting collaborations — not something that only spins up around an event.",
      },
      {
        prompt: "Who can be a Project Lead at Public Worship?",
        options: [
          "Only a team Director",
          "Anyone — a team Director or someone who just joined",
          "Only someone with prior project-management experience",
          "Only the Executive Director can appoint themselves",
        ],
        answerIndex: 1,
        explanation:
          "The role is open on purpose: ownership and initiative matter more than tenure or title, and pulling across teams works the same either way.",
      },
      {
        prompt: "What does a Project Lead actually own?",
        options: [
          "Personally executing every task on the project",
          "The timeline, cross-team coordination, and making sure the final product gets delivered — not doing every task themselves",
          "Only the budget line, nothing else",
          "Nothing until the project is finished",
        ],
        answerIndex: 1,
        explanation:
          "It's the same distinction the Events stream teaches about owning vs. doing: a Project Lead is accountable for the whole thing happening, not for personally touching every row of it.",
      },
    ],
  },

  // ── 4 · Communication ────────────────────────────────────────────────────────
  {
    slug: "foundations-communication",
    title: "Communication",
    subtitle: "Threads, tags, and no side-channels",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Slack is where Public Worship works — not group texts, not DMs. If a conversation about the mission isn't in Slack, the rest of the team can't see it, search it, or pick it up later.",
      },
      {
        kind: "bullets",
        items: [
          "**Use threads.** A back-and-forth buried in a channel is unreadable a day later — reply in a thread under the message it's about instead of flooding the channel.",
          "**Tag with intention.** @mention only when you actually need a direct response or action from that person — not as a way to be seen.",
          "**Manage your notifications.** Check Slack regularly, especially anywhere you're tagged; Slack on your phone is the difference between a same-day reply and a stalled project.",
          "**Avoid side-channels.** Keep work off iMessage, WhatsApp, and IG DMs — not because those apps are bad, but because a decision made there is invisible to everyone else on the project.",
        ],
      },
      {
        kind: "rule",
        title: "If it isn't in Slack, it didn't happen",
        text: "A side-channel conversation feels faster in the moment, but it quietly recreates the exact problem group chats and spreadsheets cause everywhere else: one person's memory becomes the plan. Slack is the record everyone else can trust and search.",
      },
      { kind: "heading", text: "The acknowledgment you owe" },
      {
        kind: "p",
        text: "On an active project, a leadership message deserves a fast response even when you can't act on it yet — a thread reply like \"seeing this, will follow up by Thursday\" costs ten seconds. Silence reads the same as \"ignored,\" whether or not that's true.",
      },
      {
        kind: "reveal",
        prompt:
          "Your team lead posts an urgent ask in the project channel and you can't get to it for two hours. What's the move?",
        answer:
          "Reply in-thread right away with what you saw and when you'll act, then do the work when you can. The quick ack buys you the two hours; staying silent is what actually breaks trust, not the delay itself.",
      },
      {
        kind: "tip",
        text: 'Further reading: "Onboarding – All Public Worship" — https://www.notion.so/2227f1c177b680998edce655167fdab4',
      },
    ],
    quiz: [
      {
        prompt:
          "Why does Public Worship ask people to avoid iMessage/WhatsApp/IG DMs for work conversations?",
        options: [
          "Those apps are considered untrustworthy",
          "It keeps every work conversation visible and transparent in one searchable place, instead of scattered where the rest of the team can't see it",
          "It's a cost-saving measure",
          "It's required by the non-profit's bylaws",
        ],
        answerIndex: 1,
        explanation:
          "The rule isn't about the apps themselves — it's that a decision made in a side-channel is invisible to everyone who wasn't in that one DM.",
      },
      {
        prompt: "What's the point of replying in a thread instead of the main channel?",
        options: [
          "Threads send push notifications faster",
          "It keeps the main channel readable by grouping a back-and-forth under the message it's actually about",
          "The main channel has a message limit",
          "Threads are private, main channels are not",
        ],
        answerIndex: 1,
        explanation:
          "Threads are a readability tool: without them, a channel becomes a wall of back-and-forth nobody can follow a day later.",
      },
      {
        prompt:
          "Your team lead pings an urgent ask in the project channel and you can't act on it for two hours. Best move?",
        options: [
          "Wait until you can fully address it, then reply once",
          "Reply in-thread immediately with what you saw and when you'll follow up, then do the work when you're able",
          "Forward it to someone else to handle",
          "Nothing — urgent asks will get chased if they're truly urgent",
        ],
        answerIndex: 1,
        explanation:
          "A fast acknowledgment costs seconds and prevents the message from reading as ignored — the actual work can still come later.",
      },
    ],
  },

  // ── 5 · Showing up ───────────────────────────────────────────────────────────
  {
    slug: "foundations-showing-up",
    title: "Showing up",
    subtitle: "Alignment over consensus, and the notice you owe",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: 'At Public Worship, meetings aren\'t just organizational — they\'re treated as spiritual discipleship, prayer, and study of the Word, and as the space where the ministry\'s direction actually gets decided. "Can two walk together, except they be agreed?" (Amos 3:3)',
      },
      {
        kind: "rule",
        title: "Alignment, not consensus — Disagree and Commit",
        text: "A meeting isn't measured by whether everyone agrees. It's measured by whether everyone feels heard, understands the reasoning, and commits to moving forward — even if they personally would have chosen differently.",
      },
      {
        kind: "table",
        headers: ["", "Directors", "Team members"],
        rows: [
          ["**Required meetings**", "Weekly director meetings", "Monthly team meetings"],
          ["**Absences allowed per year**", "Up to 4, without consequence", "Up to 2, without consequence"],
          ["**Notice required**", "At least 24 hours", "At least 24 hours"],
        ],
      },
      {
        kind: "p",
        text: "Notice under 24 hours counts as **2 absences**, not one — the penalty is for the disruption of late notice, not just for missing the meeting. Attendance is recorded 10 minutes after start time, so punctuality is part of the same respect for everyone else's time.",
      },
      { kind: "heading", text: "Why the ladder, not a blanket rule" },
      {
        kind: "p",
        text: "Exceeding the yearly threshold doesn't trigger removal — it triggers a mandatory 1:1 with the Executive Director to review the policy and reaffirm commitment. Only exceeding 1.5x the threshold (6 for directors, 3 for team members) leads to removal. The first response is always a real conversation, not an ultimatum.",
      },
      {
        kind: "reveal",
        prompt:
          "You know by Wednesday that you'll miss Friday's meeting, but you don't message your lead until Thursday night — about 18 hours before start.",
        answer:
          "That counts as 2 absences, not 1 — the late-notice rule is about the disruption of short notice, not about whether you had a good reason. Messaging on Wednesday, with well over 24 hours' notice, would have counted as a single ordinary absence.",
      },
      {
        kind: "tip",
        text: 'Further reading: "Public Worship Attendance Policy" — https://www.notion.so/27a7f1c177b680d1a98bcf579bc338b0',
      },
    ],
    quiz: [
      {
        prompt: "What does \"Disagree and Commit\" mean at Public Worship?",
        options: [
          "Everyone must agree before a decision is final",
          "Alignment, not consensus: everyone is heard and understands the reasoning, then commits to move forward even if they'd have chosen differently",
          "Disagreements are settled by majority vote, no discussion",
          "Directors' opinions always override team members'",
        ],
        answerIndex: 1,
        explanation:
          "The goal of a meeting is alignment, not unanimous agreement — being heard and understanding the reasoning is what lets someone commit even when they'd have decided differently themselves.",
      },
      {
        prompt: "What happens if you give less than 24 hours' notice for an absence?",
        options: [
          "Nothing different from normal notice",
          "It counts as 2 absences instead of 1, because of the disruption it causes",
          "It's automatically excused",
          "It results in immediate removal from the team",
        ],
        answerIndex: 1,
        explanation:
          "Late notice is penalized specifically for the disruption — double-counting toward the yearly allowance, not an automatic excuse or an automatic removal.",
      },
      {
        prompt: "What actually happens when someone exceeds their yearly absence threshold?",
        options: [
          "Immediate removal from the team",
          "A mandatory 1:1 with the Executive Director to review the policy and reaffirm commitment",
          "A public warning in the team-wide meeting",
          "Nothing — the threshold is only a suggestion",
        ],
        answerIndex: 1,
        explanation:
          "The first consequence is a conversation, not a punishment — the 1:1 exists to reaffirm commitment before anything harsher is on the table.",
      },
      {
        prompt: "When does exceeding the absence policy actually lead to removal from the team?",
        options: [
          "The very first time the threshold is exceeded",
          "At 1.5x the threshold — 6 absences for directors, 3 for team members",
          "Removal is never on the table for attendance",
          "Only if the Executive Director personally decides to remove someone, with no threshold",
        ],
        answerIndex: 1,
        explanation:
          "There's a ladder: the mandatory 1:1 comes first, and removal is reserved for exceeding 1.5x the yearly threshold — dependability matters, but the response scales.",
      },
    ],
  },

  // ── 6 · Where things live ────────────────────────────────────────────────────
  {
    slug: "foundations-where-things-live",
    title: "Where things live",
    subtitle: "PARA — and the one thing it doesn't cover",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Public Worship organizes its documentation and files with a system called PARA, split across two homes: Notion for documentation, Dropbox for media (video footage, music stems, press kits, promotional assets).",
      },
      {
        kind: "table",
        headers: ["Folder", "Used for"],
        rows: [
          ["**Projects**", 'Active initiatives with clear goals and deadlines (e.g. "Spring Worship Night")'],
          ["**Areas**", 'Ongoing responsibilities with no end date (e.g. "Marketing Strategy," "Volunteer Coordination")'],
          ["**Resources**", "Reference material — style guides, brand assets, approved song lists"],
          ["**Archive**", "Completed or inactive content"],
        ],
      },
      {
        kind: "rule",
        title: "If it's still moving, it's a Project; if it just keeps happening, it's an Area",
        text: "That's the one distinction that decides where almost anything goes. A dated initiative with an end (this Saturday's event) is a Project; a standing responsibility with no end (the ongoing social calendar) is an Area.",
      },
      { kind: "heading", text: "The one thing PARA doesn't cover" },
      {
        kind: "p",
        text: "PARA organizes information — docs, files, references. It was never meant to hold the live, minute-to-minute truth of what's happening right now: what's due today, who owns which row, whether an event is on pace. That operational truth lives in Chapter OS, not in a Notion doc. A Notion page can tell you the plan existed; the app tells you what's actually true this moment.",
      },
      {
        kind: "reveal",
        prompt:
          "Where does the brand's logo file live, versus this Saturday's task list?",
        answer:
          "The logo file is a Resource — reference material that doesn't change week to week, in Notion or Dropbox depending on the asset type. Saturday's task list isn't a document at all: it lives on the event's Tasks tab in Chapter OS, because it changes constantly and the whole team needs the current version, not a snapshot.",
      },
      {
        kind: "tip",
        text: 'Further reading: "Onboarding – All Public Worship" — https://www.notion.so/2227f1c177b680998edce655167fdab4',
      },
    ],
    quiz: [
      {
        prompt: "What does PARA stand for?",
        options: [
          "Projects, Areas, Resources, Archive",
          "People, Assets, Records, Actions",
          "Plans, Approvals, Reviews, Actions",
          "Priorities, Announcements, Reminders, Alerts",
        ],
        answerIndex: 0,
        explanation:
          "The four folders — Projects, Areas, Resources, Archive — are the whole system, applied consistently across both Notion and Dropbox.",
      },
      {
        prompt: 'Where does "the ongoing social media calendar" belong in PARA?',
        options: [
          "Projects — it has deadlines",
          "Areas — it's an ongoing responsibility with no end date",
          "Resources — it's reference material",
          "Archive — it's inactive",
        ],
        answerIndex: 1,
        explanation:
          "Areas hold standing responsibilities that just keep happening, unlike a Project (which has a start and an end) — the social calendar never 'finishes'.",
      },
      {
        prompt: "What lives in Dropbox instead of Notion?",
        options: [
          "Onboarding documentation",
          "Media files — video footage, music stems, press kits, promotional assets",
          "The attendance policy",
          "The org chart",
        ],
        answerIndex: 1,
        explanation:
          "Notion is the documentation home; Dropbox is specifically the media home — the split is by file type, not by team.",
      },
      {
        prompt: "Where does the live, current truth of what's due on an event live — a Notion doc, or Chapter OS?",
        options: [
          "A pinned Notion doc, updated by hand",
          "Chapter OS — PARA organizes reference information, not the minute-to-minute operational plan",
          "Neither; it's tracked verbally in Slack",
          "Dropbox, alongside the media files",
        ],
        answerIndex: 1,
        explanation:
          "PARA is for information that changes slowly enough to file. What's due right now, on a live event, needs one always-current source — that's what Chapter OS is for.",
      },
    ],
  },

  // ── 7 · Spending like it's not yours ────────────────────────────────────────
  {
    slug: "foundations-spending",
    title: "Spending like it's not yours",
    subtitle: "A steward's posture, before you ever touch a card",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every dollar you spend on mission work started as someone else's gift. That's true no matter which tool tracks the charge or which process is in place this year — the posture underneath doesn't change.",
      },
      {
        kind: "rule",
        title: "Every charge needs a receipt, promptly",
        text: "If you spent it on the mission, prove it — quickly, not eventually. Being slow to document a charge isn't a paperwork lapse; it's making someone else chase down what you already know.",
      },
      {
        kind: "p",
        text: "Today, spending runs through Chapter OS's own finance system — an in-app card, receipts attached in-app, and a reimbursement flow for anything you paid out of pocket. The specific mechanics (how long you have to attach a receipt, what happens if you don't, how reimbursement actually moves) belong to their own course.",
      },
      {
        kind: "reveal",
        prompt:
          "You paid for programming supplies out of your own pocket before you had a card set up. What now?",
        answer:
          "Submit a reimbursement request once you have access, and keep the receipt either way. The stewardship posture doesn't change just because the card wasn't in hand yet — the mission still owes you, and you still owe a receipt.",
      },
      {
        kind: "tip",
        text: "The full mechanics — the receipt rule, both directions of reimbursement, and how the card actually works — are in \"Finances for Everyone.\" Take that course before you carry a card.",
      },
    ],
    quiz: [
      {
        prompt: "What's the enduring posture behind every dollar spent on Public Worship's mission, regardless of which tool tracks it?",
        options: [
          "Spend freely — the mission covers it",
          "Stewardship: the money is someone else's gift, converted to dollars for a specific purpose, and every charge needs a prompt receipt",
          "Spending is discouraged entirely",
          "Only Directors are allowed to spend mission money",
        ],
        answerIndex: 1,
        explanation:
          "The posture is stewardship, not ownership — that's true no matter what the specific receipt deadline or reimbursement mechanic looks like in any given year.",
      },
      {
        prompt: "Where do the real, current mechanics of spending — receipts, the card, reimbursement — live today?",
        options: [
          "A third-party virtual card app outside Chapter OS",
          "Chapter OS's own native finance system — and the full mechanics are taught in the Finances for Everyone course",
          "There is no finance system; it's all informal",
          "A shared spreadsheet the Treasurer keeps by hand",
        ],
        answerIndex: 1,
        explanation:
          "The mechanics live in-app now, and this lesson is deliberately just a pointer — \"Finances for Everyone\" is where you learn the actual rule and flow before carrying a card.",
      },
      {
        prompt: "You paid for something mission-related out of your own pocket. What's the right move?",
        options: [
          "Let it go — small personal costs are just part of volunteering",
          "Submit a reimbursement request and keep the receipt",
          "Ask a teammate to cover it in cash",
          "Add it to your own taxes as a donation instead",
        ],
        answerIndex: 1,
        explanation:
          "Out-of-pocket mission spending is what the reimbursement flow exists for — request it, and keep the receipt so it can actually be verified.",
      },
    ],
  },
];

/** The Foundations stream's theme entry. */
export const FOUNDATIONS_THEME: Theme = {
  key: "foundations",
  title: "Foundations",
  subtitle: "Who we are, and how we work.",
};

/** The Foundations stream's courses, in catalog order. */
export const FOUNDATIONS_COURSES: Course[] = [
  {
    slug: "welcome-to-public-worship",
    themeKey: "foundations",
    title: "Welcome to Public Worship",
    level: "beginner",
    audience: "team",
    description:
      "The mission behind the work, how Public Worship is shaped into " +
      "chapters and central seats, and what each team actually does. " +
      "Start here before anything else in the Academy.",
    icon: "flag",
    moduleSlugs: [
      "foundations-seeds-and-soil",
      "foundations-chapters-and-central",
      "foundations-the-work",
    ],
  },
  {
    slug: "how-we-work",
    themeKey: "foundations",
    title: "How we work",
    level: "beginner",
    audience: "team",
    description:
      "The everyday culture: how we communicate, why showing up matters, " +
      "where information actually lives, and the posture behind every " +
      "dollar you spend.",
    icon: "layers",
    moduleSlugs: [
      "foundations-communication",
      "foundations-showing-up",
      "foundations-where-things-live",
      "foundations-spending",
    ],
  },
];
