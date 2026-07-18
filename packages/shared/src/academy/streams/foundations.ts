/**
 * The Foundations stream — who Public Worship is, before how Chapter OS
 * works. Two courses: the mission/org/teams/prayer orientation every new
 * teammate needs first ("Welcome to Public Worship"), and the everyday
 * culture that makes the rest of it work ("How we work" — communication,
 * attendance, where information lives, the posture behind spending, and
 * owning your commitments). Placed FIRST in the curriculum and catalog —
 * everything else in the Academy assumes a reader who already has this
 * context.
 *
 * Authored from the Public Worship mission/vision statement, the founder's
 * account of the org's September 2024 origin, `packages/shared/src/seats.ts`
 * (the org-chart seat taxonomy — SEAT_DEFS, the ground truth for "The work"
 * and "Chapters and central"), the July 2026 All-Team Meeting deck
 * (prayer-before-planning + local-church covering, the meeting/1:1 rhythm,
 * capacity-honesty norms), and the owner's 2026-07 course review (mission
 * stated whole rather than split across two blocks; the origin story; the
 * governance reframe — no formal board yet, nothing here implies unchecked
 * power in any one seat; and the central/chapter org model corrected against
 * SEAT_DEFS — there is no central Events team, events belong to the chapter
 * structure). Seat-change/appointment MECHANICS (who can propose or confirm
 * filling a seat) are intentionally NOT taught here — that's leadership
 * material, taught in the Directing course. Personnel are never hardcoded
 * here: who holds a seat changes, so every lesson that touches the org chart
 * points the reader to the live Org Chart tab instead of naming names.
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
        text: "Before you learn how anything in this app works, know why it exists — and where its name came from.",
      },
      {
        kind: "rule",
        title: "Our mission",
        text: "We want to create holy experiences through music, ones that ignite a wave of faith in Jesus. We strive to move seeds from rocky ground into good soil to produce fruit through genuine worship that reflects our bold identity in Christ.",
      },
      { kind: "heading", text: "The parable, and what it means for us" },
      {
        kind: "p",
        text: "The soil language comes from the parable of the sower (Matthew 13:4-9): the same seed lands on a path, on rocky ground, among thorns, and on good soil — and only one of those produces a harvest. The seed doesn't change; the ground does. That's the whole theory behind going to strangers in a park instead of only gathering the already-convinced: you can't tell which ground someone is standing on from the outside, so you go and worship anyway, and let the soil reveal itself.",
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
      { kind: "heading", text: "Where the name came from" },
      {
        kind: "story",
        title: "Long Island City, September 2024",
        text: "Public Worship was formed in September 2024. Seyi was on a prayer walk in Long Island City with his brother, looking out across the water toward Manhattan, when he saw it: a cloud of darkness hanging over New York City. Then the glory of God began to descend — pouring out over the city. It centered on Manhattan, but it didn't stay there; it rippled outward, borough to borough. People started running out of their apartments, compelled to worship God. They didn't know exactly what to do — they just knew they wanted to worship. The churches were full, so people spilled out and began worshiping in parks and public spaces instead. That's where the name came from: worship, in public.",
      },
      {
        kind: "reveal",
        prompt:
          "A stranger stops mid-set at a park event, unsure if they even belong there. What does the mission say to do?",
        answer:
          "Welcome them in, exactly as they are. You have no way of knowing whether they're standing on the path, on rocky ground, or on good soil — the mission isn't to filter for the convinced, it's to worship in public and let anyone stumble into good ground. Turning inward toward the people who already know the songs is the opposite of the point.",
      },
      {
        kind: "link",
        label: "Further reading: Mission and Vision statements",
        url: "https://www.notion.so/f759aafc092441409d189c0a5239cfdd",
      },
    ],
    quiz: [
      {
        prompt: "What is Public Worship's mission?",
        options: [
          "To hold the largest annual worship conference in the region",
          "To create holy experiences through music that ignite a wave of faith in Jesus, moving seeds from rocky ground into good soil",
          "To produce and distribute worship albums for local churches",
          "To train volunteers for other churches' Sunday services",
        ],
        answerIndex: 1,
        explanation:
          "The mission is one whole sentence, not two separate ideas: holy experiences that ignite faith, and moving seeds into good soil so genuine worship can produce fruit.",
      },
      {
        prompt:
          "In the parable of the sower, what actually differs between the path, the rocky ground, and the good soil?",
        options: [
          "The timing of when each seed happened to be planted",
          "The farmer's technique for scattering the seed",
          "The ground — the same seed either fails or produces fruit depending on where it lands",
          "The seed itself — different soils need different seeds",
        ],
        answerIndex: 2,
        explanation:
          "Same seed, different ground, different outcome. That's why the mission talks about moving seeds INTO good soil rather than finding better seeds — the work is on the ground, not the message.",
      },
      {
        prompt: "What is Public Worship's vision?",
        options: [
          "Public worship in every corner of the world — a global movement that awakens hearts and reveals God's Kingdom",
          "A single flagship campus that other cities eventually visit",
          "A subscription platform for worship music and teaching",
          "A conference circuit that trains worship leaders nationally",
        ],
        answerIndex: 0,
        explanation:
          "The vision is global and public on purpose: worship happening in every corner of the world, not confined to a building or a members-only room.",
      },
      {
        prompt:
          "Why does Public Worship worship in public — parks, plazas, train stations — instead of only inside a gathered, already-convinced room?",
        options: [
          "Public permits are easier to obtain than venue rentals",
          "It's required for the organization's nonprofit status",
          "Outdoor spaces give the band better natural acoustics",
          "You can't tell from the outside whose ground is rocky and whose is good, so you go worship where the strangers already are",
        ],
        answerIndex: 3,
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
          "**Vacancy is normal, and visible.** An empty seat shows up as empty on the chart. It doesn't get hidden, and it doesn't get silently auto-filled.",
        ],
      },
      { kind: "heading", text: "Building toward a board" },
      {
        kind: "p",
        text: "Public Worship formed in September 2024, and it's still building its organizational systems — there's no formal board in place yet. The chart you just saw, and the app it lives in, aren't the finished structure; they're being designed so a future board can sit above it and provide real governance: reviewing decisions, holding every seat accountable, and — the Executive Director's seat included — carrying the authority to appoint, remove, or replace who holds it.",
      },
      {
        kind: "rule",
        title: "No seat holds unchecked power",
        text: "The Executive Director's seat carries real authority today — org strategy, the central budget — but that authority is meant to answer to something, not float free forever. Building real oversight, with a board that can appoint or remove an Executive Director, is part of the org structure Public Worship is actively designing, not a someday idea.",
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
          "One chart per team — Events, Music, Marketing, Development",
          "Two: a central chart (the org) and a chapter chart, stamped onto every chapter",
          "One combined chart shared by everyone, regardless of city",
          "None — the org has no formal seat structure yet",
        ],
        answerIndex: 1,
        explanation:
          "Central is org-wide and exists once. Every chapter gets its own copy of the same chapter chart — same seats and shape, one instance per city.",
      },
      {
        prompt: "What actually carries a role's duties and powers — the seat, or the person?",
        options: [
          "The seat itself — duties and powers are stamped on the seat, and whoever holds it inherits exactly that job",
          "The person's seniority, or how long they've been on the team",
          "Whichever team the person originally joined when they started",
          "Nothing is defined until a specific dispute comes up",
        ],
        answerIndex: 0,
        explanation:
          "Seats, not titles: a seat's job stays the same across every person who ever holds it, which is why 'who does X' is always answerable from the chart, not from memory.",
      },
      {
        prompt: "Who can see the full org chart — both central and chapter?",
        options: [
          "Only the Executive Director",
          "Only Directors and above, across both charts",
          "Everyone — the Org Chart tab is visible to the whole team",
          "Only whoever the chart currently names",
        ],
        answerIndex: 2,
        explanation:
          "The chart is deliberately not leadership-only information — anyone can open it and see the whole shape of the org, central and chapter alike.",
      },
      {
        prompt: "What does Public Worship have in place today to govern the Executive Director's seat?",
        options: [
          "Nothing — the seat answers to no one by design",
          "An informal vote among Directors, held whenever they choose to",
          "A formal board that already holds full appointment and removal authority",
          "No formal board yet — the org and app are being built so a future board can hold every seat, the ED's included, accountable",
        ],
        answerIndex: 3,
        explanation:
          "Public Worship formed in September 2024 and doesn't have a formal board yet — but the org and the app are deliberately being built toward one, so a future board can govern every seat, the Executive Director's included, with real appoint-and-remove authority.",
      },
    ],
  },

  // ── 3 · The work ─────────────────────────────────────────────────────────────
  {
    slug: "foundations-the-work",
    title: "The work",
    subtitle: "Central functions, chapter events, and the projects that cross both",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The last lesson taught you the SHAPE of Public Worship's two charts. This one teaches what actually runs on each — and clears up an assumption worth correcting: there is no central Events team. Events belong to the chapters.",
      },
      { kind: "heading", text: "Central: the org-wide functions" },
      {
        kind: "p",
        text: "Central exists once, for the whole org, under the Executive Director. The **Financial Manager** runs central accounts and closes the books. The **Development Director** (with Partnership and Fundraising Associates) builds the relationships and funding that sustain the mission. The **Music Director** (with A&R, Artists, Musicians, and Songwriters) crafts the sound and spiritual atmosphere of every gathering. The **Marketing Director** (with a Social Media Manager, Graphic Designer, and Marketing Associates) tells the story and invites people in. The **Expansion Director** identifies and launches new chapters, and every chapter's Chapter Director rolls up under that seat.",
      },
      {
        kind: "tree",
        caption: "Central — org-wide, one instance for the whole org",
        nodes: [
          { label: "Executive Director", depth: 0 },
          { label: "Financial Manager", depth: 1 },
          { label: "Development Director", depth: 1 },
          { label: "Music Director", depth: 1 },
          { label: "Marketing Director", depth: 1 },
          { label: "Expansion Director", depth: 1 },
        ],
      },
      { kind: "heading", text: "Chapters: where events happen" },
      {
        kind: "p",
        text: "Every chapter runs its own events — Worship With Strangers, flagship gatherings, whatever that chapter hosts — under its own Chapter Director. The **Event Lead** (with Event Organizers and a Production Coordinator) owns turning an idea into a running gathering: the timeline, the volunteers, the run-of-show. The chapter's own **Music Lead** books rehearsals and sets the setlist for that chapter's events. The **Marketing Lead** promotes them locally. The **Treasurer** records and reconciles the chapter's money.",
      },
      {
        kind: "tree",
        caption: "Chapter — stamped onto every chapter, where events happen",
        nodes: [
          { label: "Chapter Director", depth: 0 },
          { label: "Treasurer", depth: 1 },
          { label: "Music Lead", depth: 1 },
          { label: "Event Lead", depth: 1 },
          { label: "Marketing Lead", depth: 1 },
        ],
      },
      {
        kind: "rule",
        title: "There is no central Events Director",
        text: "Events aren't a fourth central function alongside Music, Marketing, and Development — they belong entirely to the chapter structure. Each chapter's Event Lead, Event Organizers, and Production Coordinator own that chapter's events end to end; central doesn't run any of them.",
      },
      { kind: "heading", text: "Music's weekly rhythm is central, not chapter-by-chapter" },
      {
        kind: "p",
        text: "The Music Director's team keeps a standing weekly rhythm — studio sessions, songwriting, recorded collaborations with artists and producers. That's a CENTRAL rhythm, not something every chapter separately runs. A chapter's own Music Lead is a different, chapter-scoped job: booking rehearsals and setting the setlist for that chapter's own events.",
      },
      { kind: "heading", text: "Projects still pull from anywhere" },
      {
        kind: "p",
        text: "Not everything is a standing seat's job. Some things are projects — a worship night, a video series, a campaign — with a start and an end, and they aren't fenced inside central or inside one chapter either. A Project Lead pulls whoever the work needs, from any seat in either chart, and anyone can be one: a central Director, a chapter Event Organizer, or someone who just got here.",
      },
      {
        kind: "rule",
        title: "Not doing everything — ensuring everything gets done",
        text: "A Project Lead's job isn't to personally execute every task. It's to own the timeline and the communication, pull in whoever the project actually needs from any seat, and make sure the finished thing meets the standard Public Worship holds itself to.",
      },
      {
        kind: "reveal",
        prompt:
          "You hold a chapter's Music Lead seat. The Project Lead for a central marketing campaign asks you to help write social copy for it. Is that yours to say yes to?",
        answer:
          "Yes — projects are built to cross both charts on purpose. A Project Lead pulls whoever the work needs, whether that's a central seat or a chapter one. Your seat is your home base, not a fence around what you're allowed to help with.",
      },
      {
        kind: "tip",
        text: "In the app: open the Org Chart tab to see both charts live, central and every chapter — this lesson teaches the shape and the split, not who holds which seat this year.",
      },
    ],
    quiz: [
      {
        prompt: "Which chart do events actually live in?",
        options: [
          "Entirely inside the chapter structure — there's no central Events Director",
          "A dedicated central Events team, led by an Events Director",
          "Split evenly between central and chapter, coordinated by Expansion",
          "Central plans them; the chapter only handles day-of logistics",
        ],
        answerIndex: 0,
        explanation:
          "There is no central Events Director. Events belong entirely to the chapter structure — each chapter's Event Lead owns that chapter's events end to end.",
      },
      {
        prompt: "Which seat owns a chapter's events end to end — the timeline, volunteers, and run-of-show?",
        options: [
          "The central Expansion Director, overseeing remotely",
          "The Chapter Director, personally",
          "The Event Lead, with Event Organizers and a Production Coordinator under them",
          "The chapter's Music Lead, since most events are music-centered",
        ],
        answerIndex: 2,
        explanation:
          "The Event Lead seat, with Event Organizers and Production Coordinators under it, is what actually runs a chapter's events — the Chapter Director oversees the chapter, but doesn't personally run each event.",
      },
      {
        prompt: "Are weekly studio sessions a central rhythm, or something every chapter runs separately?",
        options: [
          "Per-chapter — every chapter books and runs its own weekly studio sessions",
          "Central — the Music Director's team runs it as a standing org-wide rhythm; a chapter's own Music Lead handles that chapter's rehearsals and setlists instead",
          "Neither — studio time only happens right before a flagship gathering",
          "Central, but only for chapters close enough to travel to the flagship city",
        ],
        answerIndex: 1,
        explanation:
          "Studio sessions, songwriting, and recorded collaborations are a central Music Team rhythm. A chapter's Music Lead has a different, chapter-scoped job: rehearsals and the setlist for that chapter's own events.",
      },
      {
        prompt: "Who can be a Project Lead, and which chart can they pull people from?",
        options: [
          "Only a central Director, pulling exclusively from central seats",
          "Only a Chapter Director, pulling exclusively from their own chapter",
          "Only the Executive Director can approve who leads any project",
          "Anyone — a Director, a chapter volunteer, or someone new — pulling whoever the project needs from either chart",
        ],
        answerIndex: 3,
        explanation:
          "The role is open on purpose, and projects cross both charts: ownership and initiative matter more than tenure, seat, or which chart someone's home seat sits in.",
      },
    ],
  },

  // ── 4 · We pray before we plan ───────────────────────────────────────────────
  {
    slug: "foundations-we-pray-before-we-plan",
    title: "We pray before we plan",
    subtitle: "The agenda waits on prayer",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every all-team gathering opens the same way: fellowship, then prayer, worship, and the Word — before a single agenda item. That order isn't a formality to get through before the \"real\" meeting starts. It's the posture the rest of the meeting sits inside.",
      },
      {
        kind: "rule",
        title: "We pray before we plan",
        text: "Pray for Public Worship, for your team, and for the people we serve — before the plan gets made, not squeezed in once the real business is done. A plan built without that prayer is still just a plan; the prayer is what makes it worship.",
      },
      { kind: "heading", text: "PW supplements — it never replaces" },
      {
        kind: "p",
        text: "Public Worship exists alongside your local church, not instead of it. Your home church is where you're planted, known, and spiritually covered — no amount of serving here changes that, or should try to.",
      },
      {
        kind: "rule",
        title: "Keep serving your local church — that's your tithe. PW is the sacrificial giving.",
        text: "Your local church gets your ordinary, ongoing commitment: consistent, expected, foundational. What you give to Public Worship sits on top of that — sacrificial giving from an already-planted life, never a replacement for having one.",
      },
      {
        kind: "reveal",
        prompt:
          "You've been giving so much time to Public Worship that you've quietly stopped attending your home church's services. What does this lesson say about that?",
        answer:
          "That's the exact drift this teaching warns against. PW is meant to supplement your walk with a local church, not crowd out the place a local church holds in it — if serving here is displacing your own covering, the fix is re-planting at home, not doing more here.",
      },
      {
        kind: "tip",
        text: "If serving here is starting to crowd out your own church attendance, that's a conversation worth having with your Director early — not something to quietly push through.",
      },
    ],
    quiz: [
      {
        prompt: "What comes before planning at a Public Worship gathering?",
        options: [
          "The agenda, worked through in order, with prayer as a brief opener",
          "Nothing — meetings move straight into business",
          "Prayer for Public Worship, the team, and the people we serve",
          "Whatever fellowship time is left over once the agenda wraps",
        ],
        answerIndex: 2,
        explanation:
          "Prayer for the mission, the team, and the people we serve comes first, genuinely — not as a warm-up act before the plan gets made.",
      },
      {
        prompt: "What is Public Worship's relationship to your local church?",
        options: [
          "It supplements local church life — it does not replace it",
          "It replaces the need to attend a local church",
          "It functions as its own denomination, separate from local churches",
          "It only matters for people already serving in leadership",
        ],
        answerIndex: 0,
        explanation:
          "PW is explicitly a supplement to local church life, never a substitute — your home church remains where you're planted and covered.",
      },
      {
        prompt: "What's the difference between your tithe and what you give to Public Worship?",
        options: [
          "Public Worship replaces your tithe entirely",
          "Your local church is the tithe — ordinary and ongoing; PW is the sacrificial giving on top of that",
          "There's no real difference — they're the same giving, tracked separately",
          "Tithing isn't something Public Worship discusses",
        ],
        answerIndex: 1,
        explanation:
          "Keep serving your local church — that's your tithe. What you give to PW is the sacrificial giving, extra on top of an already-planted life.",
      },
    ],
  },

  // ── 5 · Communication ────────────────────────────────────────────────────────
  {
    slug: "foundations-communication",
    title: "Communication",
    subtitle: "Threads, tags, and where a reply belongs",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Our communication lives in Google Chat.",
      },
      {
        kind: "bullets",
        items: [
          "**One thread per topic or task.** A decision, a blocker, a follow-up — each gets its own thread, so it's still easy to find a week later instead of buried in a wall of unrelated messages.",
          "**Replies belong inside the thread.** If a thread already exists for something, that's where your reply goes — not in the main space, even if typing there feels quicker.",
          "**@mention the person who needs to act.** Tag only who actually needs to see or do something — not the whole space, and not as a way of being seen yourself.",
          "**Email is for anything formal or external.** Talking to a partner church, a vendor, or anyone outside Public Worship? That's what email is for — Google Chat is the internal, working conversation.",
        ],
      },
      {
        kind: "rule",
        title: "Reply where the thread already is",
        text: "The single most common miss: someone starts a thread, and the reply lands in the main space instead of inside it. That splits the conversation in two and buries half of it — check for an existing thread before you type.",
      },
      {
        kind: "scenario",
        prompt:
          "Someone posts a happy-birthday message for a teammate in the main team space. You want to add your own birthday wish. Where does it go?",
        options: [
          {
            text: "Start a new thread just for your reply",
            feedback:
              "Not quite — threads are for topics and tasks that need their own trail. A birthday wish is exactly the kind of thing that belongs in the open, in the main space, not tucked into a thread nobody else opens.",
          },
          {
            text: "Reply directly in the main space, same as the birthday post",
            correct: true,
            feedback:
              "Right — a birthday shoutout isn't the start of a task thread, it's a moment for the whole space to see. Threading it off would just hide well-wishes from the people they're for.",
          },
        ],
      },
      {
        kind: "scenario",
        prompt:
          "A Project Lead posts an update in the project's space and asks for your input on one specific decision by end of day. Where does your reply go, and how do you make sure they see it?",
        options: [
          {
            text: "Post a new message in the main space so more people see it",
            feedback:
              "Not quite — a fresh main-space post detaches your input from the update it's replying to, and doesn't guarantee the one person who needs it actually sees it. Reply in the thread and tag them directly.",
          },
          {
            text: "Reply inside the update's thread and @mention the Project Lead directly",
            correct: true,
            feedback:
              "Right — the reply stays attached to the exact update it's about, and tagging the Project Lead makes sure the person who actually needs to act on it doesn't miss it in a busy space.",
          },
          {
            text: "Send the Project Lead a private DM instead",
            feedback:
              "Not quite — a DM gets the Project Lead your input, but it hides your reasoning from everyone else on the project who might need the same context later. Keep it in the thread, tagged.",
          },
        ],
      },
      {
        kind: "scenario",
        prompt:
          "You need to confirm event details with a partner church that isn't on Public Worship's Google Chat. What do you use?",
        options: [
          {
            text: "Text them from a personal phone number",
            feedback:
              "Not quite — texting works for urgent internal asks, but a formal confirmation with an outside partner needs the paper trail email gives you.",
          },
          {
            text: "Add them as a guest to a Google Chat space for the conversation",
            feedback:
              "Not quite — Chat spaces are for internal team communication. An external partner conversation is exactly what email is for.",
          },
          {
            text: "Email — it's the right tool for anything formal or external",
            correct: true,
            feedback:
              "Right — Google Chat is for internal, working conversation. Anything formal or reaching outside Public Worship belongs in email.",
          },
        ],
      },
      { kind: "heading", text: "The acknowledgment you owe" },
      {
        kind: "p",
        text: 'Acknowledge time-sensitive messages as soon as you reasonably can — even a short reply counts. "Saw this, I\'m at work, I can respond tonight" is a complete, acceptable answer. It costs ten seconds and tells the sender you have it; leaving it on read tells them nothing.',
      },
      {
        kind: "reveal",
        prompt:
          "Your Director sends a time-sensitive ask while you're at work, and you genuinely can't respond until tonight. What do you do right now?",
        answer:
          '"Saw this, I\'m at work, I can respond tonight" — sent the moment you see it, not saved up until you have a full answer. That one line tells them the message landed and buys you the hours you actually need, instead of leaving them to wonder if you saw it at all.',
      },
      { kind: "heading", text: "Finding your spaces" },
      {
        kind: "p",
        text: "Chat spaces are tied to your Google Workspace group memberships, not handed out one at a time — the right group membership brings the matching space with it. Missing a space you should have? Check your own group memberships at groups.google.com first. If something's still wrong after that, contact Operations.",
      },
      {
        kind: "link",
        label: "Further reading: Onboarding – All Public Worship",
        url: "https://www.notion.so/2227f1c177b680998edce655167fdab4",
      },
    ],
    quiz: [
      {
        prompt: "Where does Public Worship's team communication live?",
        options: [
          "Whichever app each team individually prefers to use",
          "Google Chat, organized into threads by topic and space",
          "Email, for every internal conversation",
          "Text messages, sent directly to whoever needs to know",
        ],
        answerIndex: 1,
        explanation:
          "Team communication lives in Google Chat — texting is fine for genuinely urgent things, and email is for formal or external conversations, but Chat is the everyday home.",
      },
      {
        prompt:
          "You have an update that two teammates need to see and act on. What's the right move?",
        options: [
          "Post it in the space and tag everyone so nobody misses it",
          "Text the whole team individually, one at a time",
          "Post it in the relevant team or project space and tag just those two people",
          "DM each of them separately so it feels more personal",
        ],
        answerIndex: 2,
        explanation:
          "Use the space when others need visibility — a DM hides the decision from everyone but the two of you. Tag only the people who need to act, not the whole space.",
      },
      {
        prompt:
          'Your Director pings a time-sensitive ask while you\'re at work and can\'t reply properly until tonight. What\'s the right response right now?',
        options: [
          "Wait and send one full, complete reply once you're free tonight",
          "Forward the message to someone else to handle instead",
          'A quick acknowledgment now — "Saw this, I\'m at work, I can respond tonight" — then the real reply when you can',
          "Say nothing until your Director follows up and asks again",
        ],
        answerIndex: 2,
        explanation:
          "Acknowledge time-sensitive messages as soon as you reasonably can. A ten-second ack tells the sender the message landed; silence reads as ignored whether or not that's true.",
      },
      {
        prompt: "You're missing a Chat space you should have access to. What do you check first?",
        options: [
          "Wait until the next all-team meeting to bring it up",
          "Nothing can be done — spaces are assigned by Operations at random",
          "Ask Operations to add you immediately, without checking anything first",
          "Your own Google Workspace group memberships at groups.google.com — spaces follow group membership",
        ],
        answerIndex: 3,
        explanation:
          "Chat spaces are tied to Google Workspace groups, so a missing space is usually a group-membership issue you can check yourself first — contact Operations only if it's still wrong after that.",
      },
    ],
  },

  // ── 6 · Showing up ───────────────────────────────────────────────────────────
  {
    slug: "foundations-showing-up",
    title: "Showing up",
    subtitle: "Alignment over consensus, and the notice you owe",
    minutes: 5,
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
      { kind: "heading", text: "Meetings and 1:1s aren't separate from the commitment — they ARE it" },
      {
        kind: "p",
        text: "Monthly all-team meetings are part of what it means to be on the active team — where the whole team prays, aligns, makes decisions, and builds trust together, not a status update you can skip if the agenda looks thin.",
      },
      {
        kind: "bullets",
        items: [
          "**Everyone gets a recurring 1:1 with their Director** — at least every other week, weekly encouraged while a project is actively running. It's where alignment and course-correction happen in real time, not just once a month.",
          "**Both sides own making it happen.** A 1:1 that keeps slipping isn't only the Director's miss, or only the team member's — either person can, and should, be the one who gets it back on the calendar.",
          "**Serious conflict gets communicated early**, the same way a blocker does. Sitting on a real disagreement until it grows helps nobody — say something while there's still time to work with it.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You know by Wednesday that you'll miss Friday's meeting, but you don't message your lead until Thursday night — about 18 hours before start.",
        answer:
          "That counts as 2 absences, not 1 — the late-notice rule is about the disruption of short notice, not about whether you had a good reason. Messaging on Wednesday, with well over 24 hours' notice, would have counted as a single ordinary absence.",
      },
      {
        kind: "link",
        label: "Further reading: Public Worship Attendance Policy",
        url: "https://www.notion.so/27a7f1c177b680d1a98bcf579bc338b0",
      },
    ],
    quiz: [
      {
        prompt: "What does \"Disagree and Commit\" mean at Public Worship?",
        options: [
          "Directors' opinions always override team members' opinions",
          "Everyone must agree unanimously before a decision becomes final",
          "Disagreements are settled by a quick majority vote, no discussion",
          "Alignment, not consensus: everyone is heard and understands the reasoning, then commits to move forward even if they'd have chosen differently",
        ],
        answerIndex: 3,
        explanation:
          "The goal of a meeting is alignment, not unanimous agreement — being heard and understanding the reasoning is what lets someone commit even when they'd have decided differently themselves.",
      },
      {
        prompt: "What happens if you give less than 24 hours' notice for an absence?",
        options: [
          "It results in immediate removal from the team",
          "It's automatically excused, since something urgent must have come up",
          "It counts as 2 absences instead of 1, because of the disruption short notice causes",
          "Nothing different happens compared to normal notice",
        ],
        answerIndex: 2,
        explanation:
          "Late notice is penalized specifically for the disruption — double-counting toward the yearly allowance, not an automatic excuse or an automatic removal.",
      },
      {
        prompt: "What actually happens when someone exceeds their yearly absence threshold?",
        options: [
          "A public warning, announced at the next team-wide meeting",
          "A mandatory 1:1 with the Executive Director to review the policy and reaffirm commitment",
          "Immediate removal from the team, no conversation first",
          "Nothing — the threshold is more of a suggestion than a rule",
        ],
        answerIndex: 1,
        explanation:
          "The first consequence is a conversation, not a punishment — the 1:1 exists to reaffirm commitment before anything harsher is on the table.",
      },
      {
        prompt: "When does exceeding the absence policy actually lead to removal from the team?",
        options: [
          "The very first time the yearly threshold is exceeded, no exceptions",
          "Only if the Executive Director personally decides to remove someone, with no threshold involved",
          "Removal is never actually on the table for attendance issues",
          "At 1.5x the threshold — 6 absences for directors, 3 for team members",
        ],
        answerIndex: 3,
        explanation:
          "There's a ladder: the mandatory 1:1 comes first, and removal is reserved for exceeding 1.5x the yearly threshold — dependability matters, but the response scales.",
      },
      {
        prompt: "How often should you meet 1:1 with your Director?",
        options: [
          "Only once, during your first week on the team",
          "Only if you personally request one — otherwise it's optional",
          "At least every other week, with weekly encouraged during active projects",
          "Never — 1:1s aren't part of how Public Worship operates",
        ],
        answerIndex: 2,
        explanation:
          "Every-other-week is the floor, not a suggestion — and an active project calls for going weekly. It's how alignment happens continuously, and it's on BOTH the team member and the Director to make it happen.",
      },
    ],
  },

  // ── 7 · Where things live ────────────────────────────────────────────────────
  {
    slug: "foundations-where-things-live",
    title: "Where things live",
    subtitle: "PARA — in your docs, and in the app itself",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Public Worship organizes its shared information with PARA — Projects, Areas, Resources, Archive. It's not tied to one app; it's a folder logic worth applying anywhere information piles up, across Google Drive and any other shared system you touch — including, now, inside Chapter OS itself.",
      },
      {
        kind: "table",
        headers: ["Folder", "Used for"],
        rows: [
          ["**Projects**", "Dated work with an end — an event, a campaign, a specific initiative (in the app: **Work** and **Events**)"],
          ["**Areas**", "Ongoing responsibilities with no end date (in the app: **Songs**, **Inventory**, **Finances**)"],
          ["**Resources**", "Reference material you look up, not act on (in the app: the **Academy** and the **Org Chart**)"],
          ["**Archive**", "Completed or inactive content — reserved for a future release; nothing lives here yet"],
        ],
      },
      {
        kind: "rule",
        title: "If it's still moving, it's a Project; if it just keeps happening, it's an Area",
        text: "That's the one distinction that decides where almost anything goes. A dated initiative with an end (this Saturday's event) is a Project; a standing responsibility with no end (the ongoing song catalog) is an Area.",
      },
      { kind: "heading", text: "The app is organized PARA-inspired too" },
      {
        kind: "p",
        text: "Chapter OS's own sidebar groups by that same logic, subtly: **Work** and **Events** are the Projects group — dated, with an end. **Songs**, **Inventory**, and **Finances** are Areas — standing responsibilities that don't have an end date. **Academy** and **Org Chart** are Resources — material you open to look something up in, not act on live. **Archive** is reserved for a future release; nothing lives there yet.",
      },
      {
        kind: "p",
        text: "The difference from a filed document is what's INSIDE each group. An Events row isn't something you file and forget — it's the live, minute-to-minute truth of what's happening right now: what's due today, who owns which row, whether an event is on pace. PARA tells you WHERE to look; the app is what's actually true when you get there.",
      },
      {
        kind: "reveal",
        prompt: "Where does the brand's logo file live, versus this Saturday's task list?",
        answer:
          "The logo file is a Resource — reference material that doesn't change week to week. Saturday's task list isn't a filed document at all — it lives on the event's Tasks tab, inside Work/Events, because it changes constantly and the whole team needs the current version, not a snapshot from whenever someone last saved it.",
      },
      {
        kind: "link",
        label: "Further reading: The PARA Method — Tiago Forte",
        url: "https://fortelabs.com/blog/para/",
        note: "The original productivity framework Public Worship's filing system is built on — worth reading in full if you file anything for the team.",
      },
    ],
    quiz: [
      {
        prompt: "What does PARA stand for?",
        options: [
          "Priorities, Announcements, Reminders, Alerts",
          "Projects, Areas, Resources, Archive",
          "People, Assets, Records, Actions",
          "Plans, Approvals, Reviews, Actions",
        ],
        answerIndex: 1,
        explanation:
          "The four folders — Projects, Areas, Resources, Archive — are the whole system, applied consistently across every shared system, including now inside Chapter OS.",
      },
      {
        prompt: "In Chapter OS's PARA-inspired sidebar, which group does Inventory belong to?",
        options: [
          "Resources — it's material you look up for reference",
          "Projects — it has a defined end date",
          "Areas — it's an ongoing responsibility with no end date",
          "Archive — it's no longer actively used",
        ],
        answerIndex: 2,
        explanation:
          "Areas hold standing responsibilities that just keep happening, unlike a Project (which has a start and an end) — Inventory, like Songs and Finances, never 'finishes.'",
      },
      {
        prompt: "Which two sidebar groups in Chapter OS map to PARA's \"Projects\"?",
        options: [
          "Songs and Inventory",
          "Academy and Org Chart",
          "Finances and Archive",
          "Work and Events",
        ],
        answerIndex: 3,
        explanation:
          "Work and Events are dated, with an end — exactly the Projects idea from PARA, just living inside the app instead of a filed doc.",
      },
      {
        prompt: "Where does the live, current truth of what's due on an event actually live?",
        options: [
          "A pinned document, updated by hand whenever someone remembers",
          "Inside the app, on the event's own tabs — PARA organizes reference material, not the live operational plan",
          "Nowhere formal — it's tracked verbally between teammates",
          "Wherever the original planning document was first drafted",
        ],
        answerIndex: 1,
        explanation:
          "PARA is for information that changes slowly enough to file. What's due right now, on a live event, needs one always-current source — that's what the app's own tabs are for.",
      },
    ],
  },

  // ── 8 · Spending like it's not yours ────────────────────────────────────────
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
          "Spending is discouraged entirely, no matter the purpose",
          "Only Directors are allowed to spend any mission money",
          "Stewardship: the money is someone else's gift, converted to dollars for a specific purpose, and every charge needs a prompt receipt",
          "Spend freely — the mission's budget covers whatever comes up",
        ],
        answerIndex: 2,
        explanation:
          "The posture is stewardship, not ownership — that's true no matter what the specific receipt deadline or reimbursement mechanic looks like in any given year.",
      },
      {
        prompt: "Where do the real, current mechanics of spending — receipts, the card, reimbursement — live today?",
        options: [
          "A shared spreadsheet the Treasurer keeps and updates by hand",
          "Chapter OS's own native finance system — and the full mechanics are taught in the Finances for Everyone course",
          "A third-party virtual card app that sits outside Chapter OS entirely",
          "There isn't one; spending stays informal, tracked by memory",
        ],
        answerIndex: 1,
        explanation:
          "The mechanics live in-app now, and this lesson is deliberately just a pointer — \"Finances for Everyone\" is where you learn the actual rule and flow before carrying a card.",
      },
      {
        prompt: "You paid for something mission-related out of your own pocket. What's the right move?",
        options: [
          "Let it go — small personal costs are just part of volunteering",
          "Ask a teammate to cover it in cash instead",
          "Add it to your own taxes as a personal donation instead",
          "Submit a reimbursement request, and keep the receipt",
        ],
        answerIndex: 3,
        explanation:
          "Out-of-pocket mission spending is what the reimbursement flow exists for — request it, and keep the receipt so it can actually be verified.",
      },
    ],
  },

  // ── 9 · Owning your yes ──────────────────────────────────────────────────────
  {
    slug: "foundations-owning-your-yes",
    title: "Owning your yes",
    subtitle: "A smaller yes you can keep beats a bigger one you can't",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every commitment at Public Worship is voluntary — which makes what you say yes to matter more, not less. A smaller, honest commitment beats a larger one you can't carry.",
      },
      {
        kind: "rule",
        title: "A smaller, honest commitment beats a larger one you can't carry",
        text: "Saying yes to less and delivering all of it builds more trust than saying yes to everything and quietly dropping half. Scope your yes to what's actually true about your week, not to what sounds most helpful in the moment.",
      },
      { kind: "heading", text: "If you can't own it, say so early" },
      {
        kind: "p",
        text: "Capacity changes — that's normal, not a failure. What matters is when you say something: the moment you know you can't carry a commitment, say so, while there's still time for someone else to pick it up. Disappearing, or letting a deadline quietly slip past, is what actually damages the team — not the fact that life got in the way.",
      },
      {
        kind: "bullets",
        items: [
          "**Every committed task has an owner, a deadline, and a definition of done.** If any of those three is missing or vague, the commitment isn't real yet — pin down all three before you call something owned.",
          "**Scope changes and blockers get raised early.** The moment something changes — the ask got bigger, you hit a wall — that's the moment to say so, not the day the deadline arrives.",
          "**Communication protects everyone's time.** Because we're volunteer-led, communication is how we protect one another's time — a heads-up early is a gift to whoever's counting on you.",
        ],
      },
      {
        kind: "rule",
        title: "Accountability isn't punishment",
        text: "Accountability isn't punishment — it's how we protect trust, momentum, and each other's time. Someone following up on a commitment isn't checking up on you; it's the team taking your commitment as seriously as you did when you made it.",
      },
      {
        kind: "reveal",
        prompt:
          "Two weeks into a task you volunteered for, you realize you underestimated how much time it actually needs, and you're not going to hit the deadline. What's the move?",
        answer:
          "Say so now, not at the deadline. Tell your owner or Director today that the scope grew and the timeline's at risk — that's exactly the moment raising a blocker is supposed to happen. A smaller, renegotiated commitment you can actually deliver beats silently missing the date you originally promised.",
      },
      {
        kind: "tip",
        text: "Before you say yes to something, check whether you can answer all three: who owns it, when is it due, and what does \"done\" actually look like? If you can't answer all three, it isn't a real commitment yet — for either of you.",
      },
    ],
    quiz: [
      {
        prompt: "Which commitment is more trustworthy?",
        options: [
          "Saying yes to everything asked of you, regardless of your week",
          "Never committing to anything, to avoid the risk entirely",
          "Whichever commitment sounds most impressive to say yes to",
          "A smaller, honest commitment you can actually carry",
        ],
        answerIndex: 3,
        explanation:
          "A smaller, honest yes you deliver in full builds more trust than a bigger yes that quietly falls apart halfway through.",
      },
      {
        prompt: "Partway through a task, you realize you can't finish it on time. What should you do?",
        options: [
          "Say so as soon as you know, so someone can help or the plan can adjust",
          "Say nothing and hope you catch up before anyone notices",
          "Wait until the deadline to explain what happened",
          "Quietly hand it to someone else without telling anyone",
        ],
        answerIndex: 0,
        explanation:
          "If you can't own something, say so early — don't disappear or let the deadline slip. Raising it early is what gives the team time to actually respond.",
      },
      {
        prompt: "What three things does every committed task need, per this lesson?",
        options: [
          "A chat thread, a doc, and a reminder set on someone's calendar",
          "A budget line, a location, and a rough timeline",
          "An owner, a deadline, and a definition of done",
          "A team name, a project name, and a color code",
        ],
        answerIndex: 2,
        explanation:
          "Owner, deadline, definition of done — if any of the three is missing, the commitment isn't actually pinned down yet, no matter how enthusiastic the yes was.",
      },
      {
        prompt: "Why does this lesson say accountability isn't punishment?",
        options: [
          "Because only Directors are ever actually held accountable",
          "Because volunteers can't realistically be held accountable at all",
          "Because it's how the team protects trust, momentum, and each other's time — not a way of catching someone out",
          "Because nobody actually follows up on commitments in practice",
        ],
        answerIndex: 2,
        explanation:
          "Following up on a commitment is the team taking it as seriously as you did when you made it — protection, not a gotcha.",
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
      "foundations-we-pray-before-we-plan",
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
      "foundations-owning-your-yes",
    ],
  },
];
