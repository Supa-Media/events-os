/**
 * The Foundations stream — who Public Worship is, before how Chapter OS
 * works. Two courses: the mission/org/teams/prayer orientation every new
 * teammate needs first ("Welcome to Public Worship"), and the everyday
 * culture that makes the rest of it work ("How we work" — communication,
 * attendance, where information lives (and how it can leave, via the
 * `data.export` power), the posture behind spending, and owning your
 * commitments). Placed FIRST in the curriculum and catalog — everything
 * else in the Academy assumes a reader who already has this context.
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
 * There is deliberately NO data-export lesson in this stream. One existed as
 * `foundations-data-export` ("Taking data out of the app"), moved here from
 * the Development stream on 2026-07-31 because the `data.export` grant lands
 * six seats and `how-we-work` is the one substantive course all six role
 * paths share. It was removed on 2026-09-01: carrying a director-level
 * power's lesson on every teammate's path cost more attention than it earned,
 * since most readers never hold `data.export` at all. The feature itself is
 * unchanged (`packages/shared/src/dataExport.ts`) — only the lesson is gone.
 * If it is ever reinstated, scope it to the seats that hold the power rather
 * than to the shared foundations path.
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
        kind: "rule",
        title: "Our mission",
        text: "We want to create holy experiences through music, ones that ignite a wave of faith in Jesus. We strive to move seeds from rocky ground into good soil to produce fruit through genuine worship that reflects our bold identity in Christ.",
      },
      {
        kind: "p",
        text: "The soil language comes from the parable of the sower (Matthew 13:4-9). The same seed lands on a path, on rocky ground, among thorns, and on good soil. Only the good soil produces a harvest. The seed doesn't change; the ground does. You can't tell from the outside which ground someone stands on, so Worship With Strangers meets people in public.",
      },
      {
        kind: "bullets",
        items: [
          "**The mission is soil work.** Every event, song, and post exists to move someone's ground closer to good soil, yours included.",
          "**Genuine worship is the fruit, not the event.** A perfect set can still miss. The test is whether it moved someone's ground.",
          "**Test later rules against the vision.** If a rule feels like process for its own sake, ask whether it helps move a seed into good soil.",
        ],
      },
      {
        // The official vision statement, quoted verbatim (as in the handbook).
        // A table because the sentence is longer than the prose budget's
        // 30-word cap, and a quotation isn't ours to split.
        kind: "table",
        headers: ["Statement", "Text"],
        rows: [
          [
            "Our vision",
            "To see public worship in every corner of the world, where communities gather to experience and host the presence of Jesus, inspiring a global movement of worship that awakens hearts and reveals God's Kingdom.",
          ],
        ],
      },
      {
        kind: "story",
        title: "Where the name came from",
        text: "Public Worship was formed in September 2024. Seyi was on a prayer walk in Long Island City with his brother, looking across the water toward Manhattan. He saw a cloud of darkness over New York City. Then the glory of God descended, centered on Manhattan, and rippled outward, borough to borough. People ran out of their apartments, compelled to worship. The churches were full, so they worshiped in parks and public spaces. That's where the name came from: worship, in public.",
      },
      {
        kind: "reveal",
        prompt:
          "A stranger stops mid-set at a park event, unsure they belong. What does the mission say to do?",
        answer:
          "Welcome them in as they are. You can't know whether they're on the path, on rocky ground, or on good soil. The mission is to worship in public, not to filter for the convinced.",
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
          "The mission is one idea, not two: holy experiences that ignite faith, and moving seeds into good soil so genuine worship produces fruit.",
      },
      {
        prompt:
          "In the parable of the sower, what differs between the path, the rocky ground, and the good soil?",
        options: [
          "The timing of when each seed happened to be planted",
          "The farmer's technique for scattering the seed",
          "The ground: the same seed fails or produces fruit depending on where it lands",
          "The seed itself: different soils need different seeds",
        ],
        answerIndex: 2,
        explanation:
          "Same seed, different ground, different outcome. That's why the mission talks about moving seeds into good soil rather than finding better seeds. The work is on the ground, not the message.",
      },
      {
        prompt: "What is Public Worship's vision?",
        options: [
          "Public worship in every corner of the world: a global movement that awakens hearts and reveals God's Kingdom",
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
          "Why does Public Worship worship in public (parks, plazas, train stations) instead of only in a room of the already-convinced?",
        options: [
          "Public permits are easier to obtain than venue rentals",
          "It's required for the organization's nonprofit status",
          "Outdoor spaces give the band better natural acoustics",
          "You can't tell from the outside whose ground is rocky and whose is good, so you go worship where the strangers already are",
        ],
        answerIndex: 3,
        explanation:
          "The parable is the reason. You can't see which ground a stranger is standing on, so you show up and worship in public, where the soil can reveal itself.",
      },
    ],
  },

  // ── 2 · Chapters and central ────────────────────────────────────────────────
  {
    slug: "foundations-chapters-and-central",
    title: "Chapters and central",
    subtitle: "Seats, not titles",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Public Worship is chapters (one per city) connected to a central org that supports them all. Both are org charts made of seats, not people. Every chapter gets its own copy of the same chapter chart: same seats, different city. Central exists once, so there's one Executive Director and one Financial Manager for the whole org.",
      },
      {
        kind: "table",
        headers: ["Chart", "Root seat", "Seats under it"],
        rows: [
          [
            "**Central** (org-wide, exists once)",
            "Executive Director",
            "Financial Manager, Development Director, Music Director, Marketing Director, Expansion Director",
          ],
          [
            "**Chapter** (stamped onto every chapter)",
            "Chapter Director",
            "Treasurer, Event Lead, Music Lead, Marketing Lead",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Seats, not titles",
        text: "Duties and powers are stamped on the seat, not on whoever sits in it. The Executive Director seat carries org strategy and the central budget. The Treasurer seat carries recording and reconciling chapter money. That holds no matter who sits there this year.",
      },
      {
        kind: "bullets",
        items: [
          "**Everyone can see the whole chart.** The Org Chart tab shows the central chart and every chapter's chart. It isn't leadership-only.",
          "**The chart shows who holds each seat today.** This lesson teaches its shape, not names. Look names up there instead of memorizing them.",
          "**Vacancy is normal and visible.** An empty seat shows as empty. It isn't hidden or silently auto-filled.",
          "**A seat's duties are on the chart too.** Tap a seat to read its recurring work. Managers and chapter admins can add a duty, reword it, or change its cadence there. It's the same catalog as Work → Duties.",
        ],
      },
      {
        kind: "p",
        text: "Public Worship formed in September 2024 and is still building its systems. There is no formal board yet. The chart and the app are being designed so a future board can sit above them, review decisions, and hold every seat accountable.",
      },
      {
        kind: "rule",
        title: "No seat holds unchecked power",
        text: "The Executive Director's seat carries real authority today: org strategy and the central budget. That authority is meant to answer to a future board that can appoint, remove, or replace whoever holds any seat, the Executive Director included.",
      },
      {
        kind: "reveal",
        prompt:
          "You need to know who approves your chapter's budget this month, but you've never met your Chapter Director. Where do you look?",
        answer:
          "Open the Org Chart tab and find your chapter's Chapter Director seat. It shows who holds it right now, or that it's vacant. Don't guess from an old group chat. Seats change hands, and the chart stays current.",
      },
    ],
    quiz: [
      {
        prompt: "How many org charts does Public Worship have?",
        options: [
          "One chart per team: Events, Music, Marketing, Development",
          "Two: a central chart (the org) and a chapter chart, stamped onto every chapter",
          "One combined chart shared by everyone, regardless of city",
          "None: the org has no formal seat structure yet",
        ],
        answerIndex: 1,
        explanation:
          "Central is org-wide and exists once. Every chapter gets its own copy of the same chapter chart, one per city.",
      },
      {
        prompt: "What carries a role's duties and powers: the seat, or the person?",
        options: [
          "The seat: duties and powers are stamped on it, and whoever holds it inherits that job",
          "The person's seniority, or how long they've been on the team",
          "Whichever team the person originally joined when they started",
          "Nothing is defined until a specific dispute comes up",
        ],
        answerIndex: 0,
        explanation:
          "Seats, not titles. A seat's job stays the same for everyone who holds it, so 'who does X' is answered from the chart, not from memory.",
      },
      {
        prompt: "Who can see the full org chart, central and chapter?",
        options: [
          "Only the Executive Director",
          "Only Directors and above, across both charts",
          "Everyone: the Org Chart tab is visible to the whole team",
          "Only whoever the chart currently names",
        ],
        answerIndex: 2,
        explanation:
          "The chart isn't leadership-only. Anyone can open it and see the whole org, central and chapter.",
      },
      {
        prompt: "What does Public Worship have in place today to govern the Executive Director's seat?",
        options: [
          "Nothing: the seat answers to no one by design",
          "An informal vote among Directors, held whenever they choose to",
          "A formal board that already holds full appointment and removal authority",
          "No formal board yet. The org and app are being built so a future board can hold every seat, the Executive Director's included, accountable",
        ],
        answerIndex: 3,
        explanation:
          "Public Worship formed in September 2024 and has no formal board yet. The org and app are being built so a future board can govern every seat, the Executive Director's included, with authority to appoint and remove.",
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
        text: "Central exists once, for the whole org, under the Executive Director. The **Financial Manager** runs central accounts and closes the books. The **Development Director** (with Partnership and Fundraising Associates) builds the relationships and funding that sustain the mission. The **Music Director** (with A&R, Artists, Musicians, and Songwriters) crafts the sound and spiritual atmosphere of every gathering. The **Marketing Director** (with a Social Media Manager, Graphic Designer, and Marketing Associates) tells the story and invites people in. The **Expansion Director** finds and launches new chapters, and every Chapter Director rolls up under that seat.",
      },
      {
        kind: "tree",
        caption: "Central: org-wide, one instance for the whole org",
        nodes: [
          { label: "Executive Director", depth: 0 },
          { label: "Financial Manager", depth: 1 },
          { label: "Development Director", depth: 1 },
          { label: "Music Director", depth: 1 },
          { label: "Marketing Director", depth: 1 },
          { label: "Expansion Director", depth: 1 },
        ],
      },
      {
        kind: "p",
        text: "Events belong to the chapters. Each chapter runs its own (Worship With Strangers, flagship gatherings, whatever it hosts) under its Chapter Director. The **Event Lead** (with Event Organizers and a Production Coordinator) turns an idea into a running gathering: the timeline, the volunteers, the run-of-show. The chapter's **Music Lead** books rehearsals and sets the setlist for its events. The **Marketing Lead** promotes them locally. The **Treasurer** records and reconciles the chapter's money.",
      },
      {
        kind: "tree",
        caption: "Chapter: stamped onto every chapter, where events happen",
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
        text: "Events aren't a central function alongside Music, Marketing, and Development. Each chapter's Event Lead, Event Organizers, and Production Coordinator own that chapter's events end to end. Central runs none of them.",
      },
      {
        kind: "bullets",
        items: [
          "**Music's weekly rhythm is central.** The Music Director's team runs weekly studio sessions, songwriting, and recorded collaborations with artists and producers. Chapters don't each run one.",
          "**Projects cross both charts.** A project (a worship night, a video series, a campaign) has a start and an end. Its Project Lead pulls whoever the work needs from any seat.",
          "**Anyone can be a Project Lead**, from a central Director to someone who just got here. The job is owning the timeline and communication and holding the work to Public Worship's standard, not doing every task.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You hold a chapter's Music Lead seat. The Project Lead for a central marketing campaign asks you to help write social copy. Is that yours to say yes to?",
        answer:
          "Yes. Projects cross both charts on purpose. Your seat is your home base, not a fence around what you can help with.",
      },
    ],
    quiz: [
      {
        prompt: "Which chart do events live in?",
        options: [
          "Entirely inside the chapter structure; there's no central Events Director",
          "A dedicated central Events team, led by an Events Director",
          "Split evenly between central and chapter, coordinated by Expansion",
          "Central plans them; the chapter only handles day-of logistics",
        ],
        answerIndex: 0,
        explanation:
          "There is no central Events Director. Events belong to the chapter structure, and each chapter's Event Lead owns that chapter's events end to end.",
      },
      {
        prompt: "Which seat owns a chapter's events end to end: the timeline, volunteers, and run-of-show?",
        options: [
          "The central Expansion Director, overseeing remotely",
          "The Chapter Director, personally",
          "The Event Lead, with Event Organizers and a Production Coordinator under them",
          "The chapter's Music Lead, since most events are music-centered",
        ],
        answerIndex: 2,
        explanation:
          "The Event Lead seat, with Event Organizers and a Production Coordinator under it, runs a chapter's events. The Chapter Director oversees the chapter but doesn't run each event.",
      },
      {
        prompt: "Are weekly studio sessions a central rhythm, or something every chapter runs separately?",
        options: [
          "Per-chapter: every chapter books and runs its own weekly studio sessions",
          "Central: the Music Director's team runs it as a standing org-wide rhythm, and a chapter's Music Lead handles that chapter's rehearsals and setlists",
          "Neither: studio time only happens right before a flagship gathering",
          "Central, but only for chapters close enough to travel to the flagship city",
        ],
        answerIndex: 1,
        explanation:
          "Studio sessions, songwriting, and recorded collaborations are a central Music Team rhythm. A chapter's Music Lead has a chapter-scoped job: rehearsals and the setlist for that chapter's events.",
      },
      {
        prompt: "Who can be a Project Lead, and which chart can they pull people from?",
        options: [
          "Only a central Director, pulling exclusively from central seats",
          "Only a Chapter Director, pulling exclusively from their own chapter",
          "Only the Executive Director can approve who leads any project",
          "Anyone (a Director, a chapter volunteer, or someone new), pulling whoever the project needs from either chart",
        ],
        answerIndex: 3,
        explanation:
          "The role is open on purpose, and projects cross both charts. Ownership and initiative matter more than tenure, seat, or which chart your home seat is in.",
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
        text: "Every all-team gathering opens the same way: fellowship, then prayer, worship, and the Word, before any agenda item. That order isn't a formality before the real meeting. The rest of the meeting happens inside it.",
      },
      {
        kind: "rule",
        title: "We pray before we plan",
        text: "Pray for Public Worship, for your team, and for the people we serve before the plan gets made. Don't squeeze it in after the business is done. A plan without prayer is just a plan; the prayer makes it worship.",
      },
      {
        kind: "p",
        text: "Public Worship supplements your local church; it never replaces it. Your home church is where you're planted, known, and spiritually covered. Serving here doesn't change that, and shouldn't try to.",
      },
      {
        kind: "rule",
        title: "Keep serving your local church. That's your tithe; PW is the sacrificial giving.",
        text: "Your local church gets your ordinary, ongoing commitment. What you give Public Worship sits on top of that: sacrificial giving from an already-planted life, never a replacement for one.",
      },
      {
        kind: "reveal",
        prompt:
          "You've been giving so much time to Public Worship that you've quietly stopped attending your home church's services. What does this lesson say about that?",
        answer:
          "That's the drift this lesson warns against. PW supplements your walk with a local church; it shouldn't crowd it out. If serving here is displacing your own covering, the fix is re-planting at home, not doing more here.",
      },
      {
        kind: "tip",
        text: "If serving here starts crowding out your church attendance, talk to your Director early. Don't quietly push through.",
      },
    ],
    quiz: [
      {
        prompt: "What comes before planning at a Public Worship gathering?",
        options: [
          "The agenda, worked through in order, with prayer as a brief opener",
          "Nothing: meetings move straight into business",
          "Prayer for Public Worship, the team, and the people we serve",
          "Whatever fellowship time is left over once the agenda wraps",
        ],
        answerIndex: 2,
        explanation:
          "Prayer for the mission, the team, and the people we serve comes first, as the real start, not a warm-up before the plan.",
      },
      {
        prompt: "What is Public Worship's relationship to your local church?",
        options: [
          "It supplements local church life; it does not replace it",
          "It replaces the need to attend a local church",
          "It functions as its own denomination, separate from local churches",
          "It only matters for people already serving in leadership",
        ],
        answerIndex: 0,
        explanation:
          "PW supplements local church life and never substitutes for it. Your home church is where you're planted and covered.",
      },
      {
        prompt: "What's the difference between your tithe and what you give to Public Worship?",
        options: [
          "Public Worship replaces your tithe entirely",
          "Your local church is the tithe, ordinary and ongoing; PW is the sacrificial giving on top of that",
          "There's no real difference; they're the same giving, tracked separately",
          "Tithing isn't something Public Worship discusses",
        ],
        answerIndex: 1,
        explanation:
          "Keep serving your local church. That's your tithe. What you give PW is sacrificial giving on top of an already-planted life.",
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
        text: "Our team communication lives in Google Chat.",
      },
      {
        kind: "bullets",
        items: [
          "**One thread per topic or task.** A decision, a blocker, or a follow-up each gets its own thread, so it's easy to find a week later.",
          "**Replies go inside the thread.** If a thread already exists, reply there, not in the main space, even if that feels quicker.",
          "**@mention the person who needs to act.** Tag only who needs to see or do something, not the whole space.",
          "**Email is for anything formal or external.** Partner churches, vendors, and anyone outside Public Worship get email. Google Chat is for internal, working conversation.",
        ],
      },
      {
        kind: "rule",
        title: "Reply where the thread already is",
        text: "The most common miss: someone starts a thread, and the reply lands in the main space. That splits the conversation and buries half of it. Check for an existing thread before you type.",
      },
      {
        kind: "scenario",
        prompt:
          "Someone posts a happy-birthday message for a teammate in the main team space. You want to add your own birthday wish. Where does it go?",
        options: [
          {
            text: "Reply directly in the main space, same as the birthday post",
            feedback:
              "Not quite. The birthday post is already a thread. Replying in the main space splits your wish off from it and clutters the space everyone scans for what's new.",
          },
          {
            text: "Reply inside the thread under the birthday post",
            correct: true,
            feedback:
              "Right. One thread per topic, and the birthday post is the topic. Your wish sits with every other reply, and the main space stays easy to scan.",
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
              "Not quite. A new main-space post detaches your input from the update, and the one person who needs it may still miss it. Reply in the thread and tag them.",
          },
          {
            text: "Reply inside the update's thread and @mention the Project Lead directly",
            correct: true,
            feedback:
              "Right. The reply stays attached to the update it's about, and the tag means the Project Lead won't miss it in a busy space.",
          },
          {
            text: "Send the Project Lead a private DM instead",
            feedback:
              "Not quite. A DM reaches the Project Lead but hides your reasoning from everyone else on the project who may need it later. Keep it in the thread, tagged.",
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
              "Not quite. Texting works for urgent internal asks, but a formal confirmation with an outside partner needs email's paper trail.",
          },
          {
            text: "Add them as a guest to a Google Chat space for the conversation",
            feedback:
              "Not quite. Chat spaces are for internal team communication. An external partner conversation belongs in email.",
          },
          {
            text: "Email: it's the right tool for anything formal or external",
            correct: true,
            feedback:
              "Right. Google Chat is for internal, working conversation. Anything formal or outside Public Worship goes by email.",
          },
        ],
      },
      {
        kind: "p",
        text: 'Acknowledge time-sensitive messages as soon as you reasonably can. A short reply counts: "Saw this, I\'m at work, I can respond tonight." It takes ten seconds and tells the sender you have it. Leaving it on read tells them nothing.',
      },
      {
        kind: "reveal",
        prompt:
          "Your Director sends a time-sensitive ask while you're at work, and you can't respond until tonight. What do you do right now?",
        answer:
          'Send "Saw this, I\'m at work, I can respond tonight" as soon as you see it. Don\'t wait until you have a full answer. That line tells them the message landed and buys you the hours you need.',
      },
      {
        kind: "p",
        text: "Chat spaces come with your Google Workspace group memberships; they aren't handed out one at a time. Missing a space you should have? Check your group memberships at groups.google.com first. If it's still wrong, contact Operations.",
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
          "Team communication lives in Google Chat. Texting is fine for urgent things and email is for formal or external conversations, but Chat is the everyday home.",
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
          "Use the space when others need visibility; a DM hides the decision from everyone else. Tag only the people who need to act, not the whole space.",
      },
      {
        prompt:
          'Your Director pings a time-sensitive ask while you\'re at work and can\'t reply properly until tonight. What\'s the right response right now?',
        options: [
          "Wait and send one full, complete reply once you're free tonight",
          "Forward the message to someone else to handle instead",
          'A quick acknowledgment now ("Saw this, I\'m at work, I can respond tonight"), then the real reply when you can',
          "Say nothing until your Director follows up and asks again",
        ],
        answerIndex: 2,
        explanation:
          "Acknowledge time-sensitive messages as soon as you reasonably can. A ten-second acknowledgment tells the sender the message landed. Silence reads as ignored, whether or not it is.",
      },
      {
        prompt: "You're missing a Chat space you should have access to. What do you check first?",
        options: [
          "Wait until the next all-team meeting to bring it up",
          "Nothing can be done: spaces are assigned by Operations at random",
          "Ask Operations to add you immediately, without checking anything first",
          "Your own Google Workspace group memberships at groups.google.com, since spaces follow group membership",
        ],
        answerIndex: 3,
        explanation:
          "Chat spaces follow Google Workspace groups, so a missing space is usually a group-membership issue you can check yourself. Contact Operations only if it's still wrong after that.",
      },
    ],
  },

  // ── 6 · Showing up ───────────────────────────────────────────────────────────
  {
    slug: "foundations-showing-up",
    title: "Showing up",
    subtitle: "Alignment over consensus, and the notice you owe",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: 'At Public Worship, meetings are spiritual discipleship, prayer, and study of the Word. They are also where the ministry\'s direction gets decided. "Can two walk together, except they be agreed?" (Amos 3:3)',
      },
      {
        kind: "rule",
        title: "Alignment, not consensus (Disagree and Commit)",
        text: "A meeting isn't measured by whether everyone agrees. It's measured by whether everyone feels heard, understands the reasoning, and commits to moving forward, even if they would have chosen differently.",
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
        text: "Notice under 24 hours counts as **2 absences**, not one, because late notice disrupts everyone. Attendance is recorded 10 minutes after start time, so being on time counts too.",
      },
      {
        kind: "p",
        text: "Exceeding the yearly threshold doesn't trigger removal. It triggers a mandatory 1:1 with the Executive Director to review the policy and reaffirm commitment. Only exceeding 1.5x the threshold (6 for directors, 3 for team members) leads to removal.",
      },
      {
        kind: "bullets",
        items: [
          "**Monthly all-team meetings are part of being on the active team.** The whole team prays, aligns, makes decisions, and builds trust there. Don't skip one because the agenda looks thin.",
          "**Everyone gets a recurring 1:1 with their Director.** It happens at least every other week, and weekly is encouraged while a project is running. That's where alignment and course-correction happen.",
          "**Both sides own the 1:1.** If it keeps slipping, either the Director or the team member can, and should, get it back on the calendar.",
          "**Raise serious conflict early**, the same way you'd raise a blocker, while there's still time to work with it.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You know by Wednesday that you'll miss Friday's meeting, but you don't message your lead until Thursday night, about 18 hours before start.",
        answer:
          "That counts as 2 absences, not 1. The late-notice rule is about the disruption, not whether you had a good reason. Messaging on Wednesday, with more than 24 hours' notice, would have counted as one ordinary absence.",
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
          "A meeting aims for alignment, not unanimous agreement. Being heard and understanding the reasoning lets someone commit even when they'd have decided differently.",
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
          "Late notice is penalized for the disruption: it counts double toward the yearly allowance. It isn't an automatic excuse or an automatic removal.",
      },
      {
        prompt: "What happens when someone exceeds their yearly absence threshold?",
        options: [
          "A public warning, announced at the next team-wide meeting",
          "A mandatory 1:1 with the Executive Director to review the policy and reaffirm commitment",
          "Immediate removal from the team, no conversation first",
          "Nothing: the threshold is more of a suggestion than a rule",
        ],
        answerIndex: 1,
        explanation:
          "The first consequence is a conversation, not a punishment. The 1:1 reaffirms commitment before anything harsher is on the table.",
      },
      {
        prompt: "When does exceeding the absence policy lead to removal from the team?",
        options: [
          "The very first time the yearly threshold is exceeded, no exceptions",
          "Only if the Executive Director personally decides to remove someone, with no threshold involved",
          "Removal is never on the table for attendance issues",
          "At 1.5x the threshold: 6 absences for directors, 3 for team members",
        ],
        answerIndex: 3,
        explanation:
          "There's a ladder. The mandatory 1:1 comes first, and removal is reserved for exceeding 1.5x the yearly threshold.",
      },
      {
        prompt: "How often should you meet 1:1 with your Director?",
        options: [
          "Only once, during your first week on the team",
          "Only if you personally request one; otherwise it's optional",
          "At least every other week, with weekly encouraged during active projects",
          "Never: 1:1s aren't part of how Public Worship operates",
        ],
        answerIndex: 2,
        explanation:
          "Every other week is the floor, and an active project calls for weekly. Both the team member and the Director own making it happen.",
      },
    ],
  },

  // ── 7 · Where things live ────────────────────────────────────────────────────
  {
    slug: "foundations-where-things-live",
    title: "Where things live",
    subtitle: "PARA, in your docs and in the app",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Public Worship organizes shared information with PARA: Projects, Areas, Resources, Archive. Use it anywhere information piles up, including Google Drive. Chapter OS's navigation groups the same way, in the sidebar on a computer and the phone's navigation sheet.",
      },
      {
        kind: "table",
        headers: ["Folder", "Used for"],
        rows: [
          ["**Projects**", "Dated work with an end, like an event or a campaign. In the app: **Work** and **Events**"],
          ["**Areas**", "Ongoing responsibilities with no end date. In the app: **Songs**, **Inventory**, **Finances**"],
          ["**Resources**", "Reference material you look up, not act on. In the app: the **Academy** and the **Org Chart**"],
          ["**Archive**", "Completed or inactive content. Reserved for a future release; nothing lives here yet"],
        ],
      },
      {
        kind: "rule",
        title: "If it has an end, it's a Project; if it keeps happening, it's an Area",
        text: "That one distinction decides where almost anything goes. This Saturday's event is a Project. The ongoing song catalog is an Area.",
      },
      {
        kind: "p",
        text: "Unlike a filed document, what's inside each app group is live. An event shows what's due today, who owns each row, and whether it's on pace. PARA tells you where to look; the app shows what's true when you get there.",
      },
      {
        kind: "tip",
        text: "The Academy is kept current in the app. Seats holding the **Edit Academy courses** power see **Edit course** on a course's page, and every change they publish is recorded. If a lesson is wrong, tell one of them.",
      },
      {
        kind: "reveal",
        prompt: "Where does the brand's logo file live, versus this Saturday's task list?",
        answer:
          "The logo file is a Resource: reference material that rarely changes. Saturday's task list isn't a filed document. It lives on the event's Tasks tab, under Work/Events, because it changes constantly and the team needs the current version.",
      },
      {
        kind: "link",
        label: "Further reading: The PARA Method, by Tiago Forte",
        url: "https://fortelabs.com/blog/para/",
        note: "The productivity framework Public Worship's filing system is built on. Read it in full if you file anything for the team.",
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
          "Projects, Areas, Resources, Archive: four folders, applied across every shared system, including Chapter OS.",
      },
      {
        prompt: "In Chapter OS's PARA-inspired navigation, which group does Inventory belong to?",
        options: [
          "Resources: it's material you look up for reference",
          "Projects: it has a defined end date",
          "Areas: it's an ongoing responsibility with no end date",
          "Archive: it's no longer actively used",
        ],
        answerIndex: 2,
        explanation:
          "Areas hold standing responsibilities that keep happening, unlike a Project, which has a start and an end. Inventory, like Songs and Finances, never finishes.",
      },
      {
        prompt: "Which two navigation groups in Chapter OS map to PARA's \"Projects\"?",
        options: [
          "Songs and Inventory",
          "Academy and Org Chart",
          "Finances and Archive",
          "Work and Events",
        ],
        answerIndex: 3,
        explanation:
          "Work and Events are dated, with an end: PARA's Projects idea, inside the app instead of a filed doc.",
      },
      {
        prompt: "Where does the live, current truth of what's due on an event live?",
        options: [
          "A pinned document, updated by hand whenever someone remembers",
          "Inside the app, on the event's own tabs. PARA organizes reference material, not the live operational plan",
          "Nowhere formal: it's tracked verbally between teammates",
          "Wherever the original planning document was first drafted",
        ],
        answerIndex: 1,
        explanation:
          "PARA is for information that changes slowly enough to file. What's due right now on a live event needs one current source: the app's own tabs.",
      },
    ],
  },

  // ── 8 · Spending like it's not yours ────────────────────────────────────────
  {
    slug: "foundations-spending",
    title: "Spending like it's not yours",
    subtitle: "A steward's posture, before you ever touch a card",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "Every dollar you spend on mission work started as someone else's gift. That holds no matter which tool tracks the charge or which process is in place this year.",
      },
      {
        kind: "rule",
        title: "Every charge needs a receipt, promptly",
        text: "If you spent it on the mission, prove it quickly, not eventually. A slow receipt makes someone else chase down what you already know.",
      },
      {
        kind: "p",
        text: "Today, spending runs through Chapter OS's own finance system: an in-app card, receipts attached in-app, and a reimbursement flow for anything you paid out of pocket. The details (receipt deadlines, what happens if you miss one, how reimbursement moves) have their own course.",
      },
      {
        kind: "reveal",
        prompt:
          "You paid for programming supplies out of your own pocket before you had a card set up. What now?",
        answer:
          "Submit a reimbursement request once you have access, and keep the receipt either way. Not having the card yet changes nothing: the mission owes you, and you owe a receipt.",
      },
      {
        kind: "tip",
        text: "The receipt rule, both directions of reimbursement, and how the card works are in \"Finances for Everyone.\" Take that course before you carry a card.",
      },
    ],
    quiz: [
      {
        prompt: "What posture sits behind every dollar spent on Public Worship's mission, whichever tool tracks it?",
        options: [
          "Spending is discouraged entirely, no matter the purpose",
          "Only Directors are allowed to spend any mission money",
          "Stewardship: the money is someone else's gift, converted to dollars for a specific purpose, and every charge needs a prompt receipt",
          "Spend freely: the mission's budget covers whatever comes up",
        ],
        answerIndex: 2,
        explanation:
          "The posture is stewardship, not ownership. That holds whatever the receipt deadline or reimbursement mechanic is in a given year.",
      },
      {
        prompt: "Where do the current mechanics of spending (receipts, the card, reimbursement) live today?",
        options: [
          "A shared spreadsheet the Treasurer keeps and updates by hand",
          "Chapter OS's own native finance system, with the full mechanics taught in the Finances for Everyone course",
          "A third-party virtual card app that sits outside Chapter OS entirely",
          "There isn't one; spending stays informal, tracked by memory",
        ],
        answerIndex: 1,
        explanation:
          "The mechanics live in-app, and this lesson only points to them. \"Finances for Everyone\" teaches the rule and flow before you carry a card.",
      },
      {
        prompt: "You paid for something mission-related out of your own pocket. What's the right move?",
        options: [
          "Let it go; small personal costs come with volunteering",
          "Ask a teammate to cover it in cash instead",
          "Add it to your own taxes as a personal donation instead",
          "Submit a reimbursement request, and keep the receipt",
        ],
        answerIndex: 3,
        explanation:
          "Out-of-pocket mission spending is what the reimbursement flow is for. Request it, and keep the receipt so it can be verified.",
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
        kind: "rule",
        title: "A smaller, honest commitment beats a larger one you can't carry",
        text: "Every commitment at Public Worship is voluntary, which makes your yes matter more. Saying yes to less and delivering all of it builds more trust than saying yes to everything and dropping half. Scope your yes to your real week.",
      },
      {
        kind: "p",
        text: "Capacity changes, and that's normal. What matters is when you say so. The moment you know you can't carry a commitment, say it, while someone else still has time to pick it up. Disappearing or letting a deadline slip is what damages the team.",
      },
      {
        kind: "bullets",
        items: [
          "**Every committed task has an owner, a deadline, and a definition of done.** Before you say yes, answer all three. If any is missing or vague, it isn't a real commitment yet, for either of you.",
          "**Raise scope changes and blockers early.** When the ask grows or you hit a wall, say so then, not on the day of the deadline.",
          "**Communication protects everyone's time.** We're volunteer-led, so an early heads-up is how we look after whoever is counting on you.",
        ],
      },
      {
        kind: "rule",
        title: "Accountability isn't punishment",
        text: "It's how we protect trust, momentum, and each other's time. A follow-up on your commitment isn't checking up on you. It's the team taking your commitment as seriously as you did when you made it.",
      },
      {
        kind: "reveal",
        prompt:
          "Two weeks into a task you volunteered for, you realize you underestimated how much time it needs, and you're not going to hit the deadline. What's the move?",
        answer:
          "Say so now, not at the deadline. Tell your owner or Director today that the scope grew and the timeline is at risk. A smaller, renegotiated commitment you can deliver beats silently missing the date.",
      },
    ],
    quiz: [
      {
        prompt: "Which commitment is more trustworthy?",
        options: [
          "Saying yes to everything asked of you, regardless of your week",
          "Never committing to anything, to avoid the risk entirely",
          "Whichever commitment sounds most impressive to say yes to",
          "A smaller, honest commitment you can carry",
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
          "If you can't own something, say so early. Don't disappear or let the deadline slip. Raising it early gives the team time to respond.",
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
          "Owner, deadline, definition of done. If any is missing, the commitment isn't pinned down yet, however enthusiastic the yes was.",
      },
      {
        prompt: "Why does this lesson say accountability isn't punishment?",
        options: [
          "Because only Directors are ever held accountable",
          "Because volunteers can't realistically be held accountable at all",
          "Because it's how the team protects trust, momentum, and each other's time, not a way of catching someone out",
          "Because nobody follows up on commitments in practice",
        ],
        answerIndex: 2,
        explanation:
          "Following up on a commitment is the team taking it as seriously as you did when you made it. It's protection, not a gotcha.",
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
      "chapters and central seats, and what each team does. " +
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
      "where information lives, the posture behind every dollar you " +
      "spend, and owning your commitments.",
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
