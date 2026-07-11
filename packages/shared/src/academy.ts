/**
 * The Academy — the ordered training curriculum.
 *
 * Seven article sections, each capped by a short quiz, ending in the Training
 * Event capstone. Content is authored FROM the playbook (docs/agent.md) and the
 * enablement guides (docs/guides/*) — this file is the single source both the
 * mobile Academy screens and the Convex grading backend read, so the quiz is
 * always graded server-side against exactly what the reader saw.
 *
 * Quizzes are written to teach, not to trick: every explanation restates the
 * playbook rule the question is checking.
 */

/** One quiz question. `answerIndex` points into `options`. */
export interface AcademyQuestion {
  prompt: string;
  options: string[];
  answerIndex: number;
  /** Shown after grading — restates the playbook rule, right or wrong. */
  explanation: string;
}

/** One curriculum section: an article (markdown) + its quiz. */
export interface AcademySection {
  slug: string;
  /** 1-based position in the curriculum (sections unlock in this order). */
  order: number;
  title: string;
  subtitle: string;
  /** Rough read estimate, minutes. */
  minutes: number;
  /** Markdown body, rendered by the same MarkdownView the doc pages use. */
  body: string;
  /** Empty for the capstone — its "quiz" is the Training Event quest list. */
  quiz: AcademyQuestion[];
}

/** Slug of the capstone section (completed via the Training Event, not a quiz). */
export const ACADEMY_CAPSTONE_SLUG = "capstone-training-event";

/** Slug of the platform training template the capstone instantiates. */
export const ACADEMY_TRAINING_TEMPLATE_SLUG = "academy-training";

/**
 * Whether an event counts toward chapter OPERATIONS. Academy training
 * sandboxes (`isTraining`) are real events, but they must never surface in
 * operational views: event lists, the pipeline, dashboards, Team workload
 * views, or reminder emails. Every exclusion site shares this one predicate.
 */
export function isOperationalEvent(e: {
  isTraining?: boolean | null;
}): boolean {
  return e.isTraining !== true;
}

// The curriculum, in reading order. `order` is DERIVED from array position
// (see the ACADEMY_SECTIONS export below) so a mid-curriculum insert can
// never silently break the sequential-unlock chain with duplicate or gapped
// order numbers.
const SECTIONS_IN_ORDER: Omit<AcademySection, "order">[] = [
  // ── 1 ─────────────────────────────────────────────────────────────────────
  {
    slug: "what-is-events-os",
    title: "What Events OS is",
    subtitle: "Templates, events, and the north star",
    minutes: 4,
    body: `Events OS exists to answer one question: **what would happen if the lead
got sick tomorrow?** If the answer is "chaos," the plan isn't done — no matter
what the statuses say. The north star is that any event plan must be runnable
by **one person alone, with zero tribal knowledge**. Everything else in this
curriculum is a consequence of that sentence.

## Templates and events

The two objects everything hangs off:

- A **template** is the reusable blueprint for a *kind* of event — "Worship
  With Strangers", "Eden", "Field Day". It holds the roles, the workstreams,
  and the standard tasks with their timing. Templates hold what's **always**
  true.
- An **event** is one dated instance of a template. Creating an event copies
  the template's whole structure, back-calculates every due date from the
  event date, and from then on the event is yours to edit freely. Events hold
  what's true **this time**.

The relationship runs both ways, and that's the trick. The template is the
**institutional memory**: every event exists twice — once as the thing that
happens in the park, and once as the learnings it deposits back into the
template so the next city, the next lead, the next year starts smarter.

## Never fix the same problem twice

At Eden — the flagship gathering these rules were distilled from — the retro
said *"we needed trash bags."* The fix was not a note in a doc somewhere. The
fix was a **new supplies row in the template**, so no future event can forget
them. The retro also said *"arrive earlier to secure space"* — that became an
earlier call time in the template's run of show. That's the loop: event →
retro → template → better event.

A note gets read once. A template row gets executed forever.

## What that means for you

- When you spot something an event is missing, ask: is this missing *this
  time*, or *always*? "This time" → edit the event. "Always" → it belongs in
  the template.
- When something goes wrong, the debrief turns it into a template change —
  that's why the debrief is a working session, not a feelings meeting.
- Details and how-to notes exist so the **reason survives the person**.
  "Sound permit via precinct officer, ~3 days prior, permit holder must
  attend" is worth ten "get sound permit" tasks.

Keep the north star in your pocket as you read the rest: every rule in this
Academy — ownership, T-offsets, readiness, the debrief — is just a different
way of making sure the plan doesn't live in anyone's head.`,
    quiz: [
      {
        prompt:
          "What's the difference between a template and an event?",
        options: [
          "A template is read-only; an event can be edited by admins",
          "A template is the reusable blueprint for a kind of event; an event is one dated instance cloned from it",
          "They're the same object — 'event' is just a template with a date",
          "Templates are for big events, events are for small ones",
        ],
        answerIndex: 1,
        explanation:
          "Templates hold what's ALWAYS true for a kind of event; an event clones that structure for one date and is then freely editable. The clone means later template edits never disrupt an in-flight event.",
      },
      {
        prompt: "The north star of Events OS is that any event plan must be…",
        options: [
          "Approved by a chapter admin before day-of",
          "Under budget with every task marked Done",
          "Runnable by one person alone, with zero tribal knowledge",
          "Created at least 30 days before the event date",
        ],
        answerIndex: 2,
        explanation:
          "\"Runnable by one person alone with zero tribal knowledge\" — if the lead got sick tomorrow and the answer is chaos, the plan isn't done, regardless of statuses.",
      },
      {
        prompt:
          "Eden's retro said \"we needed trash bags.\" Per the playbook, what's the correct fix?",
        options: [
          "Add a note to the retro doc so people remember",
          "Tell the next event lead in person",
          "Add a trash-bags row to the template's supplies workstream",
          "Buy trash bags now and store them",
        ],
        answerIndex: 2,
        explanation:
          "Never fix the same problem twice: retro learnings become TEMPLATE changes (a supplies row, an earlier call time), so every future event inherits the fix automatically.",
      },
      {
        prompt:
          "You notice this Saturday's event needs an extra welcome table because the venue has two entrances. Where does that change belong?",
        options: [
          "In the event — it's true this time, not always",
          "In the template — everything goes in the template",
          "Nowhere; mention it at the huddle",
          "In a separate planning spreadsheet",
        ],
        answerIndex: 0,
        explanation:
          "Templates hold what's always true; events hold what's true this time. A venue-specific tweak edits the event. If it turns out every venue needs it, the retro promotes it to the template.",
      },
    ],
  },

  // ── 2 ─────────────────────────────────────────────────────────────────────
  {
    slug: "core-concepts",
    title: "Core concepts",
    subtitle: "Workstreams, the cast, and the accountability chain",
    minutes: 6,
    body: `Get these three ideas and every screen in the app makes sense.

## Workstreams

A **workstream** is one owned area of the event plan — one stream of work that
a single role carries end-to-end. The event plan is nothing more than its
workstreams. The core seven:

| Workstream | What it holds | Default owner |
|---|---|---|
| **Planning Doc** | The master task list | Event Lead |
| **Comms Schedule** | Every message: audience, channel, copy, timing | Comms Lead |
| **Run of Show** | The minute-by-minute day-of program | Production Lead |
| **Expectations** | Volunteer teams, headcounts, duties | Comms Lead |
| **Supplies & Logistics** | Every physical item + the site map | Logistics Lead |
| **Permits** | Each permit, its lead time and status | Event Lead |
| **Retrospective** | What went well / broke / was missing / was excess | Event Lead |

Chapters can add custom workstreams (a merch stand, a food operation); they
behave exactly like the core ones. Every workstream renders as a tab on the
event page.

## The shared anatomy

Learn the parts once, use them everywhere. Every workstream is built from:

1. **An owner role** — the role accountable for the stream.
2. **Rows** — the unit of work: a task, a message, a supply item, a permit.
   Every row has a title, a status, and an accountable human.
3. **Columns** — configured per template; events inherit and can adjust.
4. **A timing mode** — day offsets (T-14 becomes a real due date), minute
   offsets (Run of Show), or a convention deadline (supplies packed by T-1).
5. **A status vocabulary with terminal states** — Done, Packed, Approved,
   Sent. Readiness math runs on these, so keeping statuses true isn't
   bookkeeping; it *is* the plan.
6. **A ready flag** — the owner marks the stream ready when its criteria are
   met. That's a claim they're putting their name on.

## The cast

- **The event owner** — the one person accountable for the event existing,
  happening, and closing out. Every event has exactly one.
- **Roles / leads** — the named hats (Event Lead, Comms Lead, Production
  Lead, Logistics Lead…). Templates assign work to roles; events put one
  person in each role. Roles before people is deliberate: it keeps templates
  portable across cities and accountability legible when people swap.
- **Workstream owners** — whoever holds a workstream's owner role.
- **Crew** — volunteers and vendors engaged for the day, organized into
  teams. Crew *execute on the day*; leads *own streams*.

## The accountability chain

Accountability for any row resolves down one chain:

**row owner → row's role → that role's person → the workstream owner → the
event owner.**

If the chain dead-ends, the row is **unowned** — and unowned work silently
fails. Nobody decides to drop it; it just never happens. That's why "zero
unowned rows by T-10" is a hard rule, and why the event owner is the end of
the chain: anything that falls through every other hand lands on them until
they hand it to someone.

One more rule worth tattooing: **one person per role per event**. Shared
ownership is how "I thought you had it" happens. Helpers are crew;
accountability is singular.`,
    quiz: [
      {
        prompt: "A row in the Comms Schedule has no owner and no role. Who is accountable for it?",
        options: [
          "Nobody — it's optional work",
          "The workstream owner, then the event owner if that dead-ends",
          "Whoever notices it first",
          "The chapter admin",
        ],
        answerIndex: 1,
        explanation:
          "Accountability resolves down the chain: row owner → row's role → role's person → workstream owner → event owner. A dead-ended chain means UNOWNED work, and unowned work silently fails.",
      },
      {
        prompt: "Why do templates assign work to roles instead of directly to people?",
        options: [
          "Because people's names change too often to store",
          "It keeps templates portable across cities and accountability legible when people swap",
          "Roles are cheaper to store in the database",
          "So nobody feels personally responsible",
        ],
        answerIndex: 1,
        explanation:
          "Roles before people: the template says 'Comms Lead does this', and each event maps that role to one person. The same template works in any city with any team.",
      },
      {
        prompt: "Two capable people both want to co-own the Run of Show. Per the playbook, what should happen?",
        options: [
          "Assign both — more owners means more gets done",
          "One holds the role and is accountable; the other helps as crew",
          "Split the workstream into two workstreams",
          "Let the assistant own it instead",
        ],
        answerIndex: 1,
        explanation:
          "One person per role per event. Shared ownership is how 'I thought you had it' happens — helpers are crew, accountability is singular.",
      },
      {
        prompt: "What does marking a workstream 'ready' actually mean?",
        options: [
          "The owner is signing their name to a claim: criteria met, or exceptions named out loud",
          "The tab gets locked from further edits",
          "All of its rows are automatically marked Done",
          "The event date is confirmed",
        ],
        answerIndex: 0,
        explanation:
          "Readiness is earned, not declared: all rows terminal, owner assigned, pre-plan cells checked — or a conscious, out-loud override ('ready, with 2 open items acknowledged').",
      },
    ],
  },

  // ── 3 ─────────────────────────────────────────────────────────────────────
  {
    slug: "planning-backwards",
    title: "Planning backwards",
    subtitle: "T-offsets, the five windows, and the hard checkpoints",
    minutes: 6,
    body: `The event date is the only fixed point; everything else is T-minus
arithmetic. **A task without timing is a wish.**

## T-notation and offsets

T-N means N days *before* the event; T+N means N days after; T-0 is the day.
Every task gets an offset, even a rough one, because offsets encode
sequencing knowledge: venue at T-30, permits at T-21, announce at T-14,
volunteers locked by T-10, supplies resolved by T-1, retro by T+7.

When you create an event, every offset becomes a **real due date**
back-calculated from the event date. Move the date and the whole timeline
moves with it — that's the entire point. But beware: **a date change is a
plan change**. Offset-derived dates shift automatically; lead-time-bound
tasks (permits!) don't compress just because the calendar moved. After any
reschedule, re-check feasibility.

## Lead times are laws of physics

Some things cannot be compressed by working harder. Earned knowledge from
real events:

- **Park/venue permit: 3+ weeks.** Eden applied and *still didn't get it* —
  survivable only because the plan had slack and a written fallback.
- **Sound permit: ~3 days**, via the local precinct — and the permit holder
  must attend the event.
- **Food permit: weeks, often blocked** — requires proof of insurance. Know
  your COI contact *before* you need one.
- **Battery charging: T-1, non-negotiable.** Pull from storage early enough
  to charge at home. "VERY IMPORTANT" in the original template for a reason.

When a lead time can't be met, the plan changes **now**: drop the item,
substitute, or move the event. Hoping is not a mitigation.

## The five windows

The lifecycle runs in five windows, each with its own definition of "good":

1. **Kickoff (→ T-14)** — the skeleton is real: date + rain plan confirmed,
   venue secured, **permit applications in flight**, budget set, core roles
   assigned, worship leader confirmed.
2. **Build (T-14 → T-7)** — everything is drafted and everyone is asked:
   announcement out (gated on venue lock), expectations written *then*
   volunteers recruited, run of show drafted, song bank sent by T-7, online
   orders placed.
3. **Lock (T-7 → T-1)** — convert every "planned" into "confirmed". **No new
   scope** — late ideas go to the next event's template.
4. **Day-of (T-0)** — execute the locked plan. Capture issues; don't re-plan
   in the park.
5. **Debrief (T+1 → T+7)** — thank-yous, feedback ask at T+3, retro by T+7,
   every retro item dispatched. This window is why the *next* event is
   easier.

## The hard checkpoints

Memorize these — the reminders and readiness math are built on them:

- Permits **started at kickoff** (they resolve later; they start now)
- Announcement **gated on venue lock** — never announce an unconfirmed venue
- Volunteers **locked by T-10** (placeholders are debts; a placeholder at
  T-3 is a hole in the day-of plan)
- Song bank sent by **T-7**
- Run of show + setlist **locked by T-3** — the T-3 and T-1 reminders quote
  its call times
- Supplies **packed + batteries charged by T-1** — Packed, not "pull from
  storage"
- Retro **dispatched by T+7**`,
    quiz: [
      {
        prompt: "An event moves from June 7 to June 14. What happens to the plan?",
        options: [
          "Nothing — dates are independent of tasks",
          "Every offset-derived due date shifts automatically, but you must re-check feasibility because lead times don't compress",
          "All tasks reset to Not started",
          "Only day-of tasks move; everything else stays",
        ],
        answerIndex: 1,
        explanation:
          "A date change is a plan change. Offsets re-derive due dates automatically (that's the point of T-offsets), but permits and other lead-time-bound work obey physics, not the calendar — so feasibility gets re-checked after every reschedule.",
      },
      {
        prompt: "When should permit applications start?",
        options: [
          "In the Lock window, once everything else is confirmed",
          "At kickoff — they start now and resolve later",
          "T-3, when the sound permit is due",
          "Whenever the venue asks for them",
        ],
        answerIndex: 1,
        explanation:
          "Permits are a kickoff task, not a Build task. Eden treated the park permit casually, applied, and didn't get it — survivable only because the plan had slack and a fallback. 3+ weeks of lead time means they start on day one.",
      },
      {
        prompt: "It's T-5 and someone proposes adding a photo booth to Saturday's event. The playbook's default answer?",
        options: [
          "Add it — enthusiasm should be rewarded",
          "Add it only if it's under budget",
          "No new scope inside T-7; it goes to the next event's template",
          "Ask the volunteers to vote",
        ],
        answerIndex: 2,
        explanation:
          "The Lock window (T-7 → T-1) converts 'planned' into 'confirmed' — no new scope. Late ideas aren't killed, they're deposited in the template where the next event gets them properly planned.",
      },
      {
        prompt: "Why must the run of show be locked by T-3 specifically?",
        options: [
          "Because printing takes three days",
          "The T-3 and T-1 volunteer reminders quote its call times — an unlocked run of show means reminders quoting fiction",
          "Because the venue requires it",
          "It's an arbitrary tradition",
        ],
        answerIndex: 1,
        explanation:
          "Checkpoints gate each other: the reminder cadence quotes call times from the run of show, so it locks at T-3. A setlist still '[TBD]' at T-2 is a red flag we've actually seen.",
      },
      {
        prompt: "What's the supplies rule at T-1?",
        options: [
          "Every item at a terminal state — Packed, batteries charged — not 'pull from storage'",
          "Half the items packed is acceptable",
          "Supplies can be resolved morning-of",
          "Only audio gear needs to be packed",
        ],
        answerIndex: 0,
        explanation:
          "Supplies terminal by T-1. 'Pull from storage' is a plan, not a state — and the battery has to come out of storage early enough to charge at home, because there's no charger in storage.",
      },
    ],
  },

  // ── 4 ─────────────────────────────────────────────────────────────────────
  {
    slug: "owning-a-workstream",
    title: "Owning a workstream",
    subtitle: "The six expectations",
    minutes: 5,
    body: `You've been assigned a role that owns a workstream — Comms, Supplies, Run
of Show, any of them. Owning a workstream means owning its **completeness**,
not doing every row yourself. Six expectations, true for every stream:

## 1. Your stream tells the truth

Rows exist for everything that must happen, statuses reflect reality, and
nothing in the stream is unowned. Update statuses **the day things happen**,
not the night before the event. Readiness is computed from statuses, so a
stale status isn't a small lie — it corrupts the number the event owner is
steering by.

## 2. Work to the deadlines

Dated rows by their due dates; undated streams by their conventions —
supplies packed by T-1, run of show locked by T-3, retro dispatched by T+7.
Your rows land in your **reminder emails** automatically. If a row isn't
getting reminders, it's missing an offset — fix that first.

## 3. Flag cross-stream needs

A planning task that implies a supply. A permit that gates a comms post. A
comms message that quotes call times from the run of show. **The owner who
spots it makes sure the other stream's row exists.** You don't do the other
stream's work — you make sure it's *seen*. The person who noticed is
responsible for the handoff happening.

## 4. Escalate early

**Blocked at T-9 is a conversation; blocked at T-2 is a crisis.** Raise
blockers to the event owner the day they appear, not once you've exhausted
your own ideas. Early escalation is a professional habit, not an admission
of failure — the event owner exists exactly for this.

## 5. Mark it ready honestly

The **Mark ready** button on your section header is you signing your name.
Criteria: all rows at a terminal status, everything owned, pre-plan cells
checked. You *can* override with open items — real events have judgment
calls — but you name the exceptions out loud: "ready, with two open items
acknowledged." The system makes overrides explicit and visible; it never
silently allows drift.

## 6. Bring the learnings

After the event, your stream's retro entries: what broke, what was missing,
what was excess — with real costs and quantities. Eden's supplies retro
produced "more blankets, fewer plates" and layout learnings (a circular
stage area beat a pointed one). Your opinion on what belongs in the template
is part of the job, because the template is where your knowledge outlives
your tenure.

## In the app

Your workstream is a tab on the event page. Click any cell to edit; status
chips cycle when tapped; changes save instantly. **Me view** filters
everything to just your work. Any cell can carry a **how-to link** — if you
figured out something the next person will need, attach it.

And the assistant knows this playbook, your guide, and your live rows. Ask
it: *"Brief me on my workstream — what's due, what's at risk, what's
unowned?"*`,
    quiz: [
      {
        prompt: "Owning a workstream primarily means…",
        options: [
          "Personally doing every row in it",
          "Owning its completeness: rows exist, statuses are true, nothing is unowned",
          "Attending every planning meeting",
          "Approving other people's edits to your tab",
        ],
        answerIndex: 1,
        explanation:
          "Expectation #1: the stream tells the truth. You're accountable that every needed row exists, statuses reflect reality, and nothing dead-ends — not that your name is on every row.",
      },
      {
        prompt:
          "While planning your Comms rows you notice the T-3 reminder needs call times that only exist in the Run of Show. It's not drafted yet. What do you do?",
        options: [
          "Nothing — Run of Show isn't your workstream",
          "Draft the run of show yourself",
          "Make sure the Run of Show owner knows and the row exists — the person who spots a cross-stream need is responsible for it being seen",
          "Remove your reminder row so it's not blocked",
        ],
        answerIndex: 2,
        explanation:
          "Expectation #3: flag cross-stream needs. You don't do the other stream's work, but spotting the dependency makes you responsible for the handoff happening.",
      },
      {
        prompt: "You're blocked on a vendor reply and the event is 9 days out. When do you tell the event owner?",
        options: [
          "Today — blocked at T-9 is a conversation, blocked at T-2 is a crisis",
          "At T-2, once it's actually urgent",
          "Only if the vendor never replies",
          "Never — solve your own blockers",
        ],
        answerIndex: 0,
        explanation:
          "Expectation #4: escalate early, the day the blocker appears. Nine days out there are options; two days out there's only damage control.",
      },
      {
        prompt: "Your stream has 2 genuinely-acceptable open items at readiness time. The honest move is…",
        options: [
          "Mark the items Done so the numbers look right",
          "Mark ready and name the exceptions out loud: 'ready, with 2 open items acknowledged'",
          "Refuse to mark ready until literally everything is terminal",
          "Delete the open items",
        ],
        answerIndex: 1,
        explanation:
          "Expectation #5: mark ready honestly. Overrides are allowed — real events have judgment calls — but they're conscious and visible, never silent. Faking statuses corrupts the readiness math everyone steers by.",
      },
    ],
  },

  // ── 5 ─────────────────────────────────────────────────────────────────────
  {
    slug: "owning-an-event",
    title: "Owning an event",
    subtitle: "The seven expectations",
    minutes: 6,
    body: `You created an event, or someone made you its owner. You are now the one
person accountable for it **existing, happening, and closing out** — the
answer to "who do I ask?" for anything without a clearer owner. Seven
expectations:

## 1. Own the calendar

Confirm the date and the rain plan. When the date moves, *you* move it — and
you re-check that every task is still feasible, because permits don't
compress just because the calendar did.

## 2. Fill the roles

Every role has one person, and every placeholder volunteer is a named human
by **T-10**. And hear this clearly: **delegation is the job**. If more than
about 40% of rows resolve to you, you're failing at the core skill. The lead
who assigns well runs three events a year without burning out; the lead who
does everything runs two and quits.

## 3. Run the rhythm

Kickoff meeting, the leads' run-of-show meeting, the day-of huddle, and the
T+2 debrief. You run them or you explicitly hand them off — they don't
happen by default.

## 4. Hold the budget

Set it at kickoff ($300 lightweight / ~$1000 full-scale are the proven
anchors), watch the rollup as costs land on rows, reconcile actuals in the
debrief window. Real learnings compound here too: florists beat Costco for
bulk flowers; 8 pizzas fed the Eden crowd; "too much food" was a retro item.

## 5. Make the readiness call

"Ready" means the conjunction: **all workstreams marked ready + all roles
assigned + no placeholders + permits resolved (approved or consciously
waived) + contingencies written** — rain plan with its own permit answer,
sound fallback, safety lead with a visible phone number. You declare it, and
you own any override, out loud. Anything less is "Planning."

## 6. Catch what falls

You are the end of the accountability chain and the escalation contact for
every lead. Respond to blockers the day they're raised. Any row whose owner
chain dead-ends lands on you until you hand it to someone.

## 7. Close the loop

The event isn't done when the crowd goes home. **Done means done**: retro
captured by T+7, every retro item dispatched (promoted to the template,
logged as context, or explicitly dropped), vendors paid, thank-yous sent.
The debrief is the most-skipped, highest-value hour in the lifecycle —
Eden's produced a dozen template improvements. Protect it.

## In the app

The **Overview tab** is your cockpit: status, reschedule, budget, roles, and
"What's next" — your prioritized action list. The four **phase rings**
(Pre-plan / Planning / Day-of / Post) are your honesty meter: they're
computed from row statuses, so they only work if owners keep statuses true.
**Day-of mode** is the big-print field view for the park. **Reschedule**
moves every derived due date with the event.

As owner, use the assistant as your chief of staff: *"Give me the owner's
briefing — T-window, risks, unowned work, unfilled roles."* · *"Is this
event actually ready? Check it against the readiness criteria."*`,
    quiz: [
      {
        prompt: "More than ~40% of an event's rows resolve to the event owner. What does the playbook call this?",
        options: [
          "Strong leadership",
          "A delegation failure and a bus-factor problem — redistribute before it becomes a burnout problem",
          "Normal for small events",
          "A reason to extend the timeline",
        ],
        answerIndex: 1,
        explanation:
          "Expectation #2: delegation IS the job. One person carrying 40%+ of the plan means the institution depends on one human — exactly what the north star forbids.",
      },
      {
        prompt: "Which of these is NOT required before an event is genuinely 'Ready'?",
        options: [
          "All workstreams marked ready",
          "No placeholder volunteers remaining",
          "Contingencies written (rain plan, sound fallback, safety lead)",
          "Every retro item dispatched",
        ],
        answerIndex: 3,
        explanation:
          "Readiness is the pre-event conjunction: workstreams ready + roles assigned + no placeholders + permits resolved + contingencies written. The retro belongs to the DEBRIEF window — it's what makes the event 'completed', not 'ready'.",
      },
      {
        prompt: "The event happened and went great. When is it 'completed'?",
        options: [
          "The moment the crowd goes home",
          "Once photos are posted",
          "After the retro is captured, learnings dispatched to the template, vendors paid, and thank-yous sent",
          "When the owner archives it",
        ],
        answerIndex: 2,
        explanation:
          "Expectation #7: close the loop. Done = happened + retro captured + learnings dispatched + vendors paid + thank-yous sent. Skipping the debrief is the one failure mode worth being pushy about.",
      },
      {
        prompt: "What are the phase rings on the event header actually measuring?",
        options: [
          "How much time is left before the event",
          "Row statuses rolled up per lifecycle phase — an honesty meter that only works if owners keep statuses true",
          "The owner's manual estimate of progress",
          "Budget consumption",
        ],
        answerIndex: 1,
        explanation:
          "The rings are computed from real row statuses (Pre-plan / Planning / Day-of / Post). That's why 'the stream tells the truth' matters: stale statuses corrupt the very number the owner steers by.",
      },
    ],
  },

  // ── 6 ─────────────────────────────────────────────────────────────────────
  {
    slug: "working-with-the-assistant",
    title: "Working with the assistant",
    subtitle: "Briefings, batching, undo, and what needs your consent",
    minutes: 5,
    body: `Every event page has an assistant that knows the playbook, the guides,
and your live plan — statuses, due dates, owners, readiness. It's not a
chatbot bolted on; it's a planning partner trained on the same rules you
just read. Knowing how it conducts itself makes you faster with it.

## It briefs before it acts

Every working session starts with situational awareness: your T-window,
phase scores, overdue and unowned rows, unassigned roles, unresolved
placeholders — then it leads with the one or two things that matter most
*now*. Not a firehose; a briefing. The fastest way to start any session:

> *"Brief me on this event."*

## It proposes, then applies — in batches

The assistant describes a batch of changes, applies it in **one revertible
run**, and summarizes what actually changed. Batch edits over row-by-row
dribbles: "add these five supplies rows and set their owners" is one
proposal, one application, one undo. Every run is reversible — if a batch
lands wrong, you can revert it. That's why you can let it work freely on
plan internals without babysitting each edit.

## Free hand vs. your consent

The line is drawn by blast radius:

**Free hand** (all revertible plan-internal edits): editing rows, statuses,
offsets, owners, role assignments.

**Asks first**: deleting anything · marking a workstream or the event
*ready* (that's a human signing their name) · changing the event date or
status · promoting changes to the template · and **anything volunteer- or
public-facing** — messages, blasts, share pages. The plan is yours to
iterate; what reaches other humans needs a human's consent.

## It uses exact values and real ids

Each workstream's status vocabulary is exact — supplies go
\`pull_from_storage → packed\`, comms go \`drafted → sent\`. The assistant
never invents a status or a row; neither should you when you ask for
changes. "Mark the battery packed" works because *packed* is a real status
on a real row.

## It nudges like a producer, not a nag

Expect nudges tied to the T-window and the playbook: *"We're at T-9 and 3
volunteer roles are unfilled — the lock point is T-10. Want me to draft the
ask for the group chat?"* One clear nudge beats five vague ones. And it
teaches while doing: ask *what* to do and you'll get the *why* from the
playbook too. The goal is not dependence — it's a lead who could run it
alone. North star, again.

## Prompts worth stealing

- *"Brief me on my workstream — what's due, what's at risk, what's unowned?"*
- *"Is this event actually ready? Check it against the readiness criteria."*
- *"We're moving to June 14th — reschedule and tell me what becomes infeasible."*
- *"Assign owners to every unassigned task from its role."*
- *"Run my debrief — interview me and draft the retro."*`,
    quiz: [
      {
        prompt: "Which of these will the assistant do WITHOUT asking you first?",
        options: [
          "Send a reminder blast to volunteers",
          "Mark the Supplies workstream ready",
          "Update row statuses, offsets, and owners in a revertible batch",
          "Delete the stale comms rows",
        ],
        answerIndex: 2,
        explanation:
          "Free hand covers revertible plan-internal edits (rows, statuses, offsets, owners, role assignments). Deleting, marking ready, date/status changes, template promotions, and anything volunteer- or public-facing all need your explicit consent.",
      },
      {
        prompt: "Why does the assistant batch its edits instead of applying them one by one?",
        options: [
          "Batches are cheaper to compute",
          "One proposal → one revertible run → one summary; a wrong batch can be undone as a unit",
          "It can only write once per conversation",
          "To hide what it changed",
        ],
        answerIndex: 1,
        explanation:
          "Propose, apply, verify, stay reversible: the batch is described first, applied in one revertible run, then summarized. That's what makes giving it a free hand on plan internals safe.",
      },
      {
        prompt: "Why won't the assistant mark a workstream ready on its own, even when every row is Done?",
        options: [
          "It can't read the ready flag",
          "Marking ready is a human signing their name to a claim — the assistant asks first",
          "Ready flags are admin-only",
          "It waits until T-1 to evaluate readiness",
        ],
        answerIndex: 1,
        explanation:
          "Readiness is earned and DECLARED by the accountable human. The assistant can tell you the criteria are met, but the signature on the claim is yours.",
      },
      {
        prompt: "What's the best first message when you open the assistant on an event you haven't looked at in a week?",
        options: [
          "\"List every row in every workstream\"",
          "\"Brief me on this event\" — it leads with the one or two things that matter most now",
          "\"Mark everything done\"",
          "\"What's the weather Saturday?\"",
        ],
        answerIndex: 1,
        explanation:
          "Situational awareness first: the assistant reads the T-window, phase scores, overdue/unowned rows, and unfilled roles, then briefs — not a firehose, a briefing.",
      },
    ],
  },

  // ── 7 ─────────────────────────────────────────────────────────────────────
  {
    slug: ACADEMY_CAPSTONE_SLUG,
    title: "Capstone: the Training Event",
    subtitle: "Run the drills in a real sandbox event",
    minutes: 10,
    body: `You've read the rules. Now you run them — in a **real event** that only
you can see.

Hitting **Start training** creates a sandbox event from the platform training
template. It's flagged as training, so it never appears in the chapter's
pipeline, dashboards, or reminder emails — but inside, it's the real thing:
real workstreams, real rows, real status chips, the real assistant. Nothing
here is a mock-up, which is why everything you do transfers one-to-one to
your first real event.

Your quests are rows in the event itself, prefixed **"Quest:"**. Each one
drills a move you'll make on every real event:

1. **Assign yourself the Comms Lead role** — the roles-before-people move.
2. **Mark the battery supply Packed** — walk a supplies row to its terminal
   state, the T-1 ritual.
3. **Add a T-3 reminder task** — plan backwards with a real offset.
4. **Mark Supplies & Logistics ready** — sign your name to a workstream.
5. **Ask the assistant for a readiness briefing** — meet your chief of staff.

The checklist below tracks itself: quests tick as their rows hit a terminal
status in your training event. The assistant inside the event knows it's a
training run — ask it for help on any quest.`,
    quiz: [],
  },
];

/**
 * The ordered curriculum. `order` is frozen from array position (1-based) so
 * it is always contiguous — the sequential-unlock chain in the backend walks
 * `order ± 1` and would silently break on duplicated or gapped numbers.
 */
export const ACADEMY_SECTIONS: AcademySection[] = SECTIONS_IN_ORDER.map(
  (s, i) => ({ ...s, order: i + 1 }),
);

/** Total number of curriculum sections (including the capstone). */
export const ACADEMY_SECTION_COUNT = ACADEMY_SECTIONS.length;

/** Look up a section by slug, or undefined. */
export function getAcademySection(slug: string): AcademySection | undefined {
  return ACADEMY_SECTIONS.find((s) => s.slug === slug);
}

/** The section after this one in curriculum order, or undefined at the end. */
export function nextAcademySection(slug: string): AcademySection | undefined {
  const current = getAcademySection(slug);
  if (!current) return undefined;
  return ACADEMY_SECTIONS.find((s) => s.order === current.order + 1);
}

/** The section before this one in curriculum order, or undefined at the start. */
export function previousAcademySection(
  slug: string,
): AcademySection | undefined {
  const current = getAcademySection(slug);
  if (!current) return undefined;
  return ACADEMY_SECTIONS.find((s) => s.order === current.order - 1);
}
