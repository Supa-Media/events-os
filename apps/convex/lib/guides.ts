// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: docs/guides/*.md (reviewed like code). Regenerate with:
//
//   node scripts/sync-guides.mjs
//
// These are the platform enablement guides, seeded into each chapter's `docs`
// table as markdown how-to docs (see `seedPlatformGuides` in convex/docs.ts).

export type PlatformGuide = {
  /** Stable key — the guide's filename without `.md`. */
  slug: string;
  /** The guide's first `# ` heading. */
  title: string;
  /** Full markdown source. */
  body: string;
};

export const PLATFORM_GUIDES: PlatformGuide[] = [
  {
    slug: "owning-the-comms-workstream",
    title: "Owning the Comms workstream",
    body: `# Owning the Comms workstream

*You've been assigned Comms Lead for an event. This is your guide. Ten-minute
read; keep it open the first week.*

## Your role in one paragraph

You own **everything the event says to anyone**: announcements to the public,
reminders to volunteers, briefings to leaders, thank-yous afterward. Owning
the stream doesn't mean writing every post yourself — it means the Comms
Schedule *tells the truth*: every message that must go out has a row, a date,
an owner, and copy, and nothing goes out late or not at all. If a row in your
stream has no owner, it's yours until you hand it to someone. Your escalation
contact is the event owner — go to them the day something gets blocked, not
the week after.

## Your deadlines

| When | What must be true |
|---|---|
| Kickoff (by T-14) | Comms Schedule reviewed against the template; flyer requested from marketing (T-14); team thread created |
| T-14 → T-11 | Main announcement out (**only after venue + date are locked — never announce an unconfirmed venue**); call for volunteers out (after the Crew Duties rows exist) |
| T-8 | Volunteer group chat created, first message sent |
| T-7 | Countdown post; volunteer role reminder; guest message; song bank sent (worship lead does it — you confirm it happened) |
| T-3 | Volunteer + guest reminders |
| T-1 | Final countdown; be-on-time to leaders; call-time reminder to volunteers |
| T-0 | Location pin + "how to find us"; D-day reminders; volunteer thank-yous |
| T+1 → T+3 | Attendee thank-you/recap; feedback request |

Why the repetition? Volunteer reminders at T-7, T-3, *and* T-1 are how 20
people show up at the same park at the same time. It's not spam; it's the job.

## Window by window

- **Kickoff:** open the Comms tab, read every seeded row, delete what doesn't
  apply *(status → Removed, don't delete — the decision is a learning)*, add
  what's missing. Request the flyer now — design takes a week.
- **Build:** announcement and volunteer call go out. Check the gate first:
  is the venue locked? Are the Crew Duties written? If not, chase those
  owners before posting anything.
- **Lock:** the reminder cadence fires. Your main job is *confirmations* —
  did each message actually go out? Mark rows Done as they post, same day.
- **Day-of:** location pin in the morning, D-day reminders, thank-yous to
  volunteers before you go to bed.
- **Debrief:** feedback ask at T+3. Bring to the retro: which messages
  worked, what you'd change in the cadence, any copy worth templating.

## In the app

- Your stream is the **Comms Schedule tab** on the event. Each row is one
  message: audience, channel, T-offset (which becomes a real due date),
  owner, and the copy (or a link to it) in notes.
- **Edit anything inline** — click a cell, type, click away. Status chips
  cycle when tapped.
- The **calendar toggle** at the top of your tab shows your rows on a
  calendar — useful for spotting pile-up days.
- **Mark the stream ready** (button on your section header) when every row is
  owned, dated, and drafted — that's you signing your name to it. If you
  override with open items, say so to the event owner.
- Your **due dates land in your reminder emails** automatically. If a row
  isn't getting reminders, it's missing an offset — fix that first.

## Working with others

- **Event owner:** venue/date lock gates your announcement. Confirm before
  posting.
- **Crew Duties owner:** the volunteer call points at the Crew Duties rows —
  don't recruit into a vacuum.
- **Worship lead:** you confirm the song bank went to vocalists and
  instrumentalists by T-7 (they send it; you verify).
- **Production lead:** run-of-show call times feed your T-3/T-1 reminders —
  chase them if the run of show isn't locked by T-3, because your reminders
  quote it.
- **Marketing/design:** flyer request at T-14 with the event brief attached.

## "Done" looks like

Every row Done or consciously Removed · every audience (public, attendees,
worshippers, leaders, volunteers) touched in every window · thank-yous sent ·
feedback request out · your retro notes captured.

## Wisdom from past events

- Eden's announcement went out **T-33** and it wasn't too early. Earlier beats
  later for public events.
- Messages that got *Removed* at Eden (4-day countdown, duplicate guest
  pings) stayed in the schedule as Removed — next event's comms lead saw the
  decision and didn't re-litigate it. Do the same.
- The volunteer group chat (T-8) mattered more than any public post: it's
  where call times, the site pin, and day-of changes actually reached people.

## Ask the agent

The assistant on your event page knows this playbook and your live schedule.
Try:

- *"Brief me on comms — what's due this week and what's at risk?"*
- *"Check audience coverage: is any audience missing a touch between T-7 and
  T-0?"*
- *"Draft the T-3 volunteer reminder using our call times and location."*
- *"Add a row: TikTok countdown at T-2, owned by me."*
- *"The venue just changed to McCarren Park — which of my rows mention the
  old location?"*
`,
  },
  {
    slug: "so-you-own-a-workstream",
    title: "So you own a workstream",
    body: `# So you own a workstream

*You've been assigned a role that owns one or more workstreams of an event.
This is the five-minute version of what that means. Your specific workstream
(Comms, Supplies, Run of Show…) has its own guide with the details — this one
covers what's true for all of them.*

## What a workstream is

A workstream is one owned area of the event plan — a stream of work one person
carries end-to-end. The event plan is nothing more than its workstreams:
Tasks, Comms Schedule, Run of Show, Crew Duties, Supplies & Logistics
(which includes the site map), Permits, Debrief (plus any custom ones
this event added). Each renders as a tab on the event page.

Every workstream is built the same way:

- **Rows** — the unit of work: a task, a message, a supply item, a permit.
  Every row has a title, a status, and an accountable human.
- **Statuses with a "done" state** — Done, Packed, Approved, Sent. Readiness
  is computed from these, so keeping them true is not bookkeeping, it *is*
  the plan.
- **Timing** — rows carry T-offsets that become real due dates (T-7 = seven
  days before the event), minute offsets (Run of Show), or a convention
  deadline for the whole stream (e.g. Supplies packed by T-1).
- **A ready flag** — the button on your section header. Marking your stream
  ready is you signing your name to it.

## What's expected of you

Owning a workstream means owning its **completeness**, not doing every row:

1. **Your stream tells the truth.** Rows exist for everything that must
   happen, statuses reflect reality, nothing is unowned. Update statuses the
   day things happen, not the night before the event.
2. **Work to the deadlines.** Dated rows by their due dates; undated streams
   by their conventions. Your guide has your T-table.
3. **Flag cross-stream needs.** A task in your stream that implies a supply,
   a permit, or a message in another stream? Make sure the other stream's
   owner has the row — the person who spots it is responsible for it being
   seen.
4. **Escalate early.** Blocked at T-9 is a conversation; blocked at T-2 is a
   crisis. Tell the event owner the day something gets stuck.
5. **Mark ready honestly.** All rows done or consciously accepted — and if
   you override with open items, name them out loud.
6. **Bring the learnings.** After the event, your retro entries — what broke,
   what was missing, what was excess, real costs and quantities — and your
   opinion on what should change in the template.

## In the app

- Your workstream is a **tab on the event page**. Click any cell to edit;
  status chips cycle when tapped; changes save instantly.
- Rows assigned to your role (or to you) appear in your **reminder emails**
  and in **"What's next"** on the event overview.
- **Me view** (toggle on the event page) filters everything to just your
  work.
- The **Mark ready** button lives on your section header.
- Any cell can carry a **how-to link** — if you figured out something the
  next person will need, attach it. That's how your knowledge outlives your
  tenure.

## Ask the agent

The assistant on the event page knows the playbook, your workstream's guide,
and your live rows. Try:

- *"Brief me on my workstream — what's due, what's at risk, what's unowned?"*
- *"What does 'ready' mean for this stream and how far am I?"*
- *"Add the rows I'm missing compared to the template."*
- *"I'm blocked on X — who should I talk to and what's the fallback?"*
`,
  },
  {
    slug: "so-you-own-an-event",
    title: "So you own an event",
    body: `# So you own an event

*You created an event, or someone made you its owner. You are now the one
person accountable for it existing, happening, and closing out. This guide is
the ten-minute version of the job.*

## Your role in one paragraph

The event owner is the answer to "who do I ask?" for anything without a
clearer owner. You don't do everything — in fact, if more than about 40% of
tasks resolve to you, you're failing at the core skill, which is delegation.
Your job is that every workstream has an owner, every owner knows their
deadlines, blockers reach you early, and the plan is honest. You are the end
of the accountability chain: any row whose owner chain dead-ends lands on
you until you hand it to someone.

## The seven expectations

1. **Own the calendar.** Confirm the date and the rain plan. When the date
   moves, you move it — and you re-check that every task is still feasible
   (permits don't compress because the calendar moved).
2. **Fill the roles.** Every role has one person and every placeholder
   volunteer is a named human by **T-10**. One person per role — shared
   ownership is how "I thought you had it" happens.
3. **Run the rhythm.** Kickoff meeting, the leads' run-of-show meeting, the
   day-of huddle, and the debrief. You run them or explicitly hand them off.
4. **Hold the budget.** Set it at kickoff ($300 lightweight / ~$1000
   full-scale are the proven anchors), watch the rollup, reconcile actuals
   afterward.
5. **Make the readiness call.** "Ready" means: all workstreams marked ready,
   all roles assigned, no placeholders, permits resolved or consciously
   waived, contingencies written. You declare it, and you own any override —
   out loud.
6. **Catch what falls.** You're the escalation contact for every lead.
   Respond to blockers the day they're raised.
7. **Close the loop.** The event isn't done when the crowd goes home. Done =
   retro captured, learnings dispatched to the template, vendors paid,
   thank-yous sent.

## The five windows (your calendar as owner)

- **Kickoff (→ T-14):** create from the right template; date + rain plan
  locked; venue secured; **permit applications in flight** (they start now,
  they resolve later); budget set; core roles assigned; worship leader
  confirmed; kickoff meeting held; team thread created.
- **Build (T-14 → T-7):** announcement out (only after venue lock);
  expectations doc written, then volunteers recruited; run of show drafted;
  setlist confirmed and song bank sent by T-7; online orders placed.
- **Lock (T-7 → T-1):** roles and placeholders resolved (chase from T-10);
  volunteer meeting held; run of show locked T-3; supplies packed and
  batteries charged T-1; no new scope — late ideas go to the next event's
  template.
- **Day-of (T-0):** arrive early, run the huddle, execute the locked plan.
  Capture issues as they happen; don't re-plan in the park.
- **Debrief (T+1 → T+7):** thank-yous T+1, feedback ask T+3, retro by T+7 —
  and every retro item either promoted to the template, kept as context, or
  explicitly dropped. Then, and only then, mark the event completed.

## In the app

- **Create** from Pipeline → New event: template, name, date, location. The
  whole task timeline back-calculates from the date.
- The **Overview tab** is your cockpit: status, reschedule, budget, roles,
  and **"What's next"** — your prioritized action list, grouped by phase.
- The four **phase rings** in the header (Pre-plan / Planning / Day-of /
  Post) are your honesty meter — they're computed from row statuses, so they
  only work if owners keep statuses true.
- **Assign roles** from the Overview; assign workstream owners from each
  section header. **"Share crew"** gives volunteers their no-login briefing
  page.
- **Day-of mode** (button on the event) is the big-print field view for the
  park: live clock, now/next, call times, contacts.
- **Reschedule** from the Overview moves every derived due date with the
  event.

## Wisdom from past events

- Eden applied for its park permit and **didn't get it** — the event survived
  because the plan had slack and a written fallback. Start permits at
  kickoff, and never carry a permit without a "what if denied" line.
- The retro is the most-skipped, highest-value hour in the lifecycle. Eden's
  produced a dozen template improvements ("arrive earlier", "more blankets",
  "bring trash bags", "get a COI contact"). Protect it.
- Delegation compounds: the lead who assigns well runs three events a year
  without burning out; the lead who does everything runs two and quits.

## Ask the agent

The assistant on your event page reads the live plan. As owner, use it as
your chief of staff:

- *"Give me the owner's briefing — T-window, risks, unowned work, unfilled
  roles."*
- *"Is this event actually ready? Check it against the readiness criteria."*
- *"We're moving to June 14th — reschedule and tell me what becomes
  infeasible."*
- *"Assign owners to every unassigned task from its role."*
- *"Run my debrief — interview me and draft the retro."*
`,
  },
];
