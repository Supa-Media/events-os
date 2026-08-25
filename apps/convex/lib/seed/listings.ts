/**
 * The migration payload for the ONE role that existed as markdown when job
 * listings moved into the OS: `apps/landing/src/content/roles/people-director.md`.
 *
 * Kept verbatim here so `listings.seedListingsIfEmpty` can restore it into the
 * `jobListings` table on a fresh deployment — nothing the old role page showed
 * is lost in the move. Once every environment has a listings row, this file is
 * dead weight and can go; it exists only to carry the markdown across the seam.
 *
 * Typed loosely (no generated types) like the other seed data — it is plain
 * content, inserted by the mutation that owns the table shape.
 */

/** Noon UTC on the posting date, so no timezone renders it a day early. */
const POSTED_AT = Date.parse("2026-08-23T12:00:00Z");

export const PEOPLE_DIRECTOR_LISTING = {
  slug: "people-director",
  title: "People Director",
  status: "open" as const,
  published: true,
  team: "People",
  commitment: "Volunteer",
  location:
    "Remote, or NYC-based preferred — with some travel for training and chapter launches",
  hoursPerWeek: 10,
  reportsTo: "Executive Director",
  worksWith: [
    "Functional Directors (Music, Marketing, Development, Events, Finance)",
    "Chapter Directors",
  ],
  manages: ["Chapter Directors", "The People team as it grows"],
  trialTrack: "director" as const,
  seatId: "expansion_director",
  order: 1,
  summary:
    "The seat responsible for building the people and leadership capacity Public Worship grows through — recruiting, development, and the chapters that come out of both. Designed as the Executive Director's number two.",
  whyThisSeatExists:
    "We're volunteer-led, so what limits growth isn't money or ideas — it's leadership and people capacity. Right now every significant people conversation runs through the Executive Director: every yes, every no, every \"are we ready.\" That doesn't scale, and it isn't good for the team. People growth builds leadership capacity, and healthy expansion follows from that. New chapters are the outcome, not the point.",
  outcomes: [
    {
      outcome: "One pipeline everyone who wants to join passes through",
      doneWhen:
        "Someone can apply, be interviewed against a shared standard, run a real trial, and get a yes, a no, a why, or a not-yet — without the ED touching it.",
    },
    {
      outcome: "What makes this team good, written down",
      doneWhen:
        "Interviews with the current team have become an interview standard, an onboarding path, and a development rhythm someone else could run.",
    },
    {
      outcome: "Teams ready before chapters launch",
      doneWhen:
        "We're actively recruiting for the chapters coming next, and each one's leadership team is trained and ready before a launch date is set.",
    },
    {
      outcome: "A leadership bench, not a list of names",
      doneWhen:
        "You can name who's ready for more responsibility, who's close, and what they're missing — and their directors are working on it.",
    },
    {
      outcome: 'A specific answer to "how are our people?"',
      doneWhen:
        "The answer comes with names, patterns, and what you're doing about the people who are struggling.",
    },
  ],
  authority: [
    "Say no, or not yet, to a candidate — including one a director wants",
    "Set the interview standard and onboarding path the whole org uses",
    "Call whether a chapter's people are ready to launch, or not yet",
    "Choose and develop Chapter Directors, with the ED on the final call",
    "Own team culture events — what they are, when, and what they cost within budget",
    "Decide when a people problem is a systems problem, and change the system",
  ],
  responsibilities: [
    {
      area: "Recruiting and talent",
      items: [
        "Own both pipelines — dedicated team seats, and the volunteers who serve at gatherings",
        "Build the interview and discernment system out of what already works here, not out of a template",
        "Recruit for central teams and for the chapters coming next",
        "Spot high-potential future leaders early, and say so out loud",
        "Sit in personally on discernment for senior seats and Chapter Directors",
      ],
    },
    {
      area: "People and leadership development",
      items: [
        "Onboarding, role clarity, and expectations for every new person",
        "Training, leadership development, and director development",
        "The 1:1s and reviews that actually happen",
        "Volunteer health and retention — noticing who's quietly carrying too much",
        "Team culture events, as people health rather than a favor to Events",
        "Helping directors develop their own people instead of doing it for them",
        "Fixing the system when people repeatedly fall through the cracks",
      ],
    },
    {
      area: "Chapter development and expansion",
      items: [
        "Chapter Director recruiting, formation, and a real coaching cadence",
        "Forming each chapter's leadership team — central doesn't staff every local seat",
        "Chapter onboarding, training, launch readiness, and the City Launch Playbook",
        "Chapter health and leadership succession inside chapters",
        "The go / not-yet call on whether the people exist before a city launches",
      ],
    },
  ],
  rhythms: [
    "Weekly 1:1 with the Executive Director",
    "A standing coaching cadence with each Chapter Director",
    "A weekly pass through both pipelines — nobody waits on us more than a week",
    "A monthly read on people health: who's thriving, who's struggling, who's ready for more",
  ],
  firstNinetyDays: [
    "Interview the current team and write down what actually makes it good",
    "Turn that into a first interview standard and onboarding path, and run the next candidate through it",
    "Take both pipelines off the Executive Director's desk",
    "Name the seats the next chapters need, and start filling them",
    "Bring back one thing that's broken about how we develop people — with three options and a recommendation",
  ],
  required: [
    "Spiritually mature and rooted in a local church you attend and give to",
    "Genuinely good with people — able to see someone clearly and still be kind about it",
    "Comfortable in ambiguity; able to build structure where none exists",
    "Willing to make hard calls about fit, and to say why out loud",
    "More interested in developing leaders than in managing tasks",
    "Around 10 hours a week, honestly, plus recurring meetings",
  ],
  preferred: [
    "Experience hiring, onboarding, or developing people — paid or volunteer",
    "Experience starting something in a new city or context",
    "Comfort writing things down: process, standards, playbooks",
  ],
  notThisRole: [
    "Not HR administration. You build the function first; the admin gets delegated later so you can focus on judgment and coaching",
    "Not the manager of every volunteer. Functional Directors own their teams' work",
    "Not assessing functional excellence in Music, Marketing, Events, Finance, or Development",
    "Not central fundraising or day-to-day finance",
    "Not launching cities because there's interest — only because the people are ready",
  ],
  successLooks: [
    "Public Worship can grow without the ED personally carrying every people conversation",
    'Someone can answer "how are our people?" with specificity',
    "A chapter launches because its people are ready, and everyone can see why that was true",
  ],
  growthPath:
    "This seat can grow into a department — a coordinator, recruiters, an onboarding lead, chapter coaches. At the start you build it yourself. It's designed as the ED's number two, and could develop someone toward eventually succeeding the ED, though succession is never automatic.",
  body: "There's no finished people system here and no playbook waiting for you. The first real work is interviewing the team we already have to find out what makes it good, then turning that into something repeatable. You'd be building the function, not inheriting it.\n\nOne thing worth saying plainly: this is sacrificial extra work on top of a local church commitment. Public Worship is not a church and isn't trying to be yours. Everyone here serves and gives at their own church first.",
  postedAt: POSTED_AT,
};
