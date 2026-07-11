# Plan: training & enablement — how people learn Events OS

**Goal.** Nobody should need a training session to run an event. The software
teaches the person, in context, at the moment they take on a responsibility —
with the agent as the always-available trainer. This plan defines the
curriculum, the delivery mechanics, and the infra needed.

Companion docs: `docs/agent.md` (the playbook — the *craft* source of truth),
`docs/plans/worship-event-planning-agent.md` (agent capabilities).

---

## 1. Principles for training

1. **One source of truth, many doors.** The playbook (`docs/agent.md`) holds
   the craft. Guides don't restate philosophy — they slice it by role and add
   the software mechanics ("here's your job" + "here's the button"). When the
   playbook changes, guides inherit it.
2. **Just-in-time beats up-front.** People don't read manuals; they read the
   guide that appears the moment they're assigned Comms Lead for an event
   three weeks out. Every guide is delivered at the moment of responsibility,
   not at signup.
3. **The agent is the trainer.** Every guide ends with "ask the agent"
   example prompts. Training people to converse with the agent *is* training
   them on the software — and the agent knows the playbook, the guide, and
   the person's live event state, so it can tutor against real work instead
   of abstractions.
4. **The system knows who's new.** `roleAssignments.by_person` and engagement
   history tell us whether this is someone's first time as a workstream
   owner, an event owner, or crew. First-timers get the walkthrough; veterans
   get the checklist.
5. **Training is part of the north star.** "Runnable by one person alone with
   zero tribal knowledge" — the guides are where the tribal knowledge goes to
   become non-tribal.

---

## 2. The curriculum (four levels, by responsibility)

### Level 0 — Volunteer / crew (no login required)
**Needs to know:** their team, their lead's name + number, call time, dress
code, where the run of show is. **Delivery:** the public briefing page
(`share/[id]`) already does this — it IS the volunteer training. Add: a short
"what to expect at a public worship event" intro block for first-time
volunteers.

### Level 1 — Team member with a login
**Needs to know:** how to find their work (Me view, Team page), update a row
status, read the day-of screen. **Delivery:** a 5-minute "Finding your work"
guide + first-login pointer to it.

### Level 2 — Workstream owner
**Needs to know:** the generic craft of owning a stream (the six expectations
in playbook Part I), plus their specific workstream's guide. **Delivery:**
two docs — "So you own a workstream" (generic, short) and the per-workstream
guide (see catalog) — delivered when the role that owns the workstream is
assigned to them.

### Level 3 — Event owner
**Needs to know:** the seven expectations (playbook Part I), the five-window
lifecycle, and the event-owner mechanics (create from template, feasibility,
roles, readiness call, reschedule, debrief). **Delivery:** "So you own an
event" guide at assignment/creation + the agent's kickoff briefing.

### Level 4 — Template author / chapter admin
**Needs to know:** template editing, the event → template promotion loop,
roles/workstreams/columns design, and that templates are the institution.
**Delivery:** "Building templates that teach" guide.

---

## 3. The guide catalog

All guides live in-repo under `docs/guides/` (source of truth, reviewed like
code) and are **seeded into the app as platform how-to docs** (markdown docs
with share URLs) so they're linkable and shareable to people without
accounts. Guides are **platform-owned and read-only** — seeding always
updates them to the latest version. Chapter-specific knowledge lives in
templates and how-to docs, never in guide forks.

**The standard guide skeleton** (every guide follows it — see the exemplar
`docs/guides/owning-the-comms-workstream.md`):

1. **Your role in one paragraph** — what you own, where you sit in the
   accountability chain
2. **Your deadlines** — the T-table for this responsibility
3. **Window by window** — what to do in Kickoff / Build / Lock / Day-of /
   Debrief
4. **In the app** — the mechanics: where things live, how to edit, what
   "ready" means and how to mark it
5. **Working with others** — your cross-stream touchpoints
6. **"Done" looks like** — the readiness criteria you're signing your name to
7. **Wisdom from past events** — real failure modes and learnings
8. **Ask the agent** — copy-paste example prompts for this role

Catalog (⭐ = write first):

| Guide | Level | Status |
|---|---|---|
| What to expect (volunteer intro) | 0 | to write |
| Finding your work | 1 | to write |
| ⭐ So you own a workstream (generic) | 2 | to write |
| ⭐ Owning the Comms workstream | 2 | **written — exemplar** |
| Owning the Planning Doc | 2 | to write |
| Owning Supplies & Logistics (incl. site map) | 2 | to write |
| Owning the Run of Show | 2 | to write |
| Owning Permits | 2 | to write |
| Owning Expectations (volunteer teams) | 2 | to write |
| Owning the Retro | 2 | to write |
| Owning the Setlist (Worship Lead) | 2 | to write |
| ⭐ So you own an event | 3 | to write |
| Building templates that teach | 4 | to write |

Per-workstream guides should be short (1–2 screens); the generic workstream
guide carries the shared anatomy so specific guides only carry what's
different.

---

## 4. Delivery mechanics (the infra to build)

1. **Seed guides as platform docs.** Extend the existing `docs` table seeding:
   platform-authored markdown docs keyed by guide slug, always updated to the
   latest platform version on seed (like core workstreams: platform-owned,
   never forked; read-only in the app). Guides get share URLs for free.
2. **Assignment-triggered delivery.** When `roleAssignments.assign` fires (or
   an engagement is confirmed): if the role owns workstreams, the
   notification/email includes links to the matching guides. **First-time
   detection:** no prior `roleAssignments.by_person` rows for this role →
   lead with "first time? start here" framing and have the agent proactively
   offer a walkthrough in that event's chat.
3. **"How this works" affordance on every surface.** Each workstream section
   header, the event overview, and the template editor get a quiet help
   affordance linking the matching guide (reuses the how_to doc-linking
   pattern that already exists for cells).
4. **Agent as trainer.** Add guides to the agent's retrievable context
   (`get_guide(slug)` tool or compiled alongside the playbook). Behaviors:
   the kickoff briefing for a new event owner; "I notice this is your first
   time owning Comms — want the 2-minute version?"; answering "what am I
   supposed to do?" with the person's actual next actions from their guide +
   live event state.
5. **Onboarding checklists as rows.** For first-time event owners, the agent
   can offer to add a "learn the ropes" mini-checklist into their Planning
   Doc (meta: the training uses the same row/status machinery being taught).

---

## 5. Sequencing

1. Write the ⭐ guides (comms exemplar done; generic workstream; event owner).
2. Guide seeding as platform docs + "How this works" links (small, high
   leverage, zero new UI patterns).
3. Assignment-triggered guide delivery + first-time detection.
4. Agent trainer behaviors (needs the playbook-in-prompt work from the
   capabilities plan anyway — same PR territory).
5. Remaining catalog, prioritized by which roles are assigned most.

---

## 6. The Academy: one-stop tutorial (next phase — own PR, DECIDED)

Markdown docs are the reference layer, not the training experience. The
decided shape is a **one-stop "Learn Events OS" hub**: an ordered curriculum
of article sections, each ending in a short quiz, capped by the Training
Event. Proposed curriculum (drawn from the playbook + guides):

1. What Events OS is — templates, events, and the north star
2. Core concepts — workstreams, the cast, the accountability chain
3. Planning backwards — T-offsets, due dates, the five windows
4. Owning a workstream — the six expectations (+ per-workstream pages)
5. Owning an event — the seven expectations
6. Working with the assistant — briefings, batching, undo, what needs consent
7. **Capstone: the Training Event** (quest checklist, assistant as tutor)

Per-person progress (sections read, quiz scores, capstone state) is stored so
the hub shows a completion path and leads know who's trained. Mechanics
below; original three-layer framing kept for the component detail:

1. **Guide pages (routes, not rendered markdown).** `/guide/[slug]` composed
   from a guide-component kit: hero, step cards, callouts (Eden pull-quotes),
   the T-deadline table as a styled timeline, annotated screenshots, pretty
   cross-links, and "ask the agent" prompts as one-tap chips that open the
   assistant pre-filled. The repo markdown stays the canonical *text* source
   feeding prose blocks; pages are TSX. A public no-auth `/g/[slug]` variant
   (same pattern as `share/[id]` / `d/[shareId]`) keeps no-login volunteer
   sharing. The Overview Guides section and workstream "?" links point here;
   the seeded read-only docs remain as the fallback/share layer until pages
   fully replace them.
2. **"Try it" blocks — the real UI embedded with throwaway local state.** A
   real grid row whose status chip you practice cycling, a real role picker,
   a real "Mark ready" toggle. No mock UI to build or maintain; nothing
   touches the database; practice is pixel-identical to the job.
3. **The Training Event (the game).** A platform "Training: run your first
   event" template; "Start training" instantiates a real sandbox event
   (flagged `isTraining`, excluded from pipeline stats + reminder emails)
   whose rows ARE the quests: assign yourself the Comms role · mark the
   battery packed · add a T-3 task · mark a workstream ready · ask the
   assistant for a briefing. Completion detection is the real data
   (statuses/assignments/readiness) rendered as a quest checklist; the
   assistant is the tutor (it already has the playbook + get_readiness).
   Finish = wrap-up screen; the training event archives itself. Learning by
   doing the actual job in the actual interface — everything transfers 1:1.

## 7. Open questions

- **Q1 — Forking semantics: RESOLVED — guides are platform-owned, never
  forked.** Guides teach invariant mechanics (roles, ownership, the app);
  chapter variation belongs in templates and how-to docs (different
  permitting, car city vs. train city). Seeding always updates guides to the
  latest platform version and they render read-only in-app.
- **Q2 — Email vs in-app delivery.** Assignment emails already exist
  (Resend); is a guide link in that email enough, or do we want an in-app
  "you have a new responsibility" surface? (Recommend email link first.)
- **Q3 — Completion tracking.** Do we track "read the guide"? (Recommend no —
  track outcomes via readiness/todos instead; reading receipts are theater.)
