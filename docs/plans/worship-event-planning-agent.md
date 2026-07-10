# Worship Event Planning Agent — principles & lifecycle improvements (DISCUSSION DRAFT)

**Goal.** Make the AI assistant an absolute sage for public worship event
planning — pre-planning, working the modules, assigning people, day-of, and the
post-event loop — and encode the same best practices for the human user. This
document is the sync artifact: agree on the principles first, then build the
`agent.md` playbook + new tools on top of them.

Sources: the real Eden 2026 plan and the WWS template
(`docs/notion-reference/eden.md`, `wws.md`), the shipped data model
(`apps/convex/schema/*`, `packages/shared/src/index.ts`), the AI spine
(`apps/convex/ai.ts`, `aiActions.ts`), and the mobile UX
(`apps/mobile/app/(app)/event/[id].tsx` and friends).

---

## 1. Where we are today (one paragraph of context)

The system is already shaped right: templates (eventTypes + roles + modules +
base items with T-offsets) clone into events; due dates back-calculate from the
event date; four lifecycle phases (prePlan → planning → dayOf → post) are
scored from item status; module owners resolve role → person; reminders email
overdue/due work daily and weekly; every AI write is revertible. The assistant,
though, can only add/edit **items** inside one event (plus photos), and the
lifecycle has no enforcement: statuses are manual, readiness is self-attested,
nothing triggers the retro, and supplies/run-of-show never generate reminders.

---

## 2. Principles to sync on

These are drawn from what the Eden retro and WWS template *actually taught us*,
generalized into rules the agent (and UI) should embody.

### P1. The template is the institutional memory
"Runnable by one person alone, with zero tribal knowledge" is already the north
star in the system prompt. The corollary: **every event should leave the
template better than it found it.** The Eden retro produced concrete template
changes ("arrive earlier to secure space", "buy 20 more blankets", "get a COI
contact", "text-blast app for volunteers") — but today retro rows die in the
grid. The agent's job at T+2 is to run the debrief and *propose template
patches* from it.

### P2. Plan backwards from the event date; everything datable gets a date
T-offsets are the spine (Eden's comms ran T-33 → T+3). Today only
planning_doc/comms/permits get `dueDate`s, so supplies, run-of-show, and retro
are invisible to reminders. Best practice: every module has a timing
convention even when items don't carry offsets (supplies resolve by T-1,
run-of-show locks by T-3, retro completes by T+7) and the system reminds
against those conventions.

### P3. Roles before people; placeholders must resolve
Templates assign work to **roles** (WWS deliberately ships with empty Owner
columns and a Role select); events map roles to people. That's correct — keep
it. The gap: placeholder crew and unassigned roles never get *forced* to
resolve. Best practice: a hard checkpoint (~T-10, matching Eden's "recruit
volunteers + assign owners" task) where every role has a person, every
placeholder is swapped, and every item resolves to a human.

### P4. Readiness is earned, not declared
"Mark ready" is a bare boolean and `setStatus` accepts anything — you can mark
an event Ready at 0% readiness. Best practice: readiness criteria per module
(all items terminal-status, owner assigned, pre-plan cells checked) and
event-level gates (all modules ready + all roles assigned + permits approved
→ *then* Ready). Decide: hard blocks vs. loud warnings (recommend warnings +
an explicit override, so the tool never fights a human in a hurry).

### P5. Real-world lead times are constraints, not suggestions
Eden's permits story: park permit applied weeks out, sound permit via precinct
officer ~3 days prior, permit holder must attend, COI blocked the food permit
entirely. Offsets today are arbitrary signed ints with no floor — creating an
event 5 days out silently produces tasks due in the past. Best practice: items
can carry a `minLeadDays`; event creation and reschedule run a **feasibility
check** and surface "these 4 tasks are already late / infeasible" immediately.

### P6. Some tasks gate others
Venue → permits → announce → recruit is a dependency chain, only implied by
offsets today. A lightweight `blockedBy` on items (template-authored, cloned to
events) lets the agent reason about *critical path*, not just dates: "you can't
launch comms until the venue is confirmed, and venue confirmation is overdue."

### P7. Communication is a planned artifact with a standard cadence
The comms module is already core. The Eden/WWS cadence is a reusable pattern
the agent should know cold: announce ~T-14/T-33, volunteer call T-11, run-of-
show meeting T-12→T-5, volunteer reminders T-7/T-3/T-1, day-of location pin
T-0, thank-yous T-0, feedback ask T+3. Each comm has an **audience** and a
**channel** — the agent should flag missing audience coverage (e.g., no
volunteer reminder scheduled inside T-3).

### P8. Day-of is a different mode with contingencies
Run of show with call times (arrival → huddle → setup → start), a safety lead
with a phone number, a rain plan, a sound fallback. The day-of screen exists
and is good. The gap is **contingency planning as structure**: the agent should
verify rain plan / safety contact / permit-holder-on-site exist as fields or
items before it lets dayOf read "ready".

### P9. People are a renewable resource
The schema aspires to rotation/burnout tracking (`roleAssignments.by_person`)
but nothing computes load. Best practice: when assigning, the agent checks
concurrent-event load and recent-event history ("Sarah has led 3 of the last 4
events — consider rotating") and never leaves a person triple-booked silently.

### P10. The agent proposes, batches, and stays revertible
Already partially true (revertible runs, `update_items` batching). Extend it:
the agent makes *plans of changes* it summarizes before/after, uses the real
mutations (not parallel re-implementations — today `applyItemPatch` diverges
from `items.setStatus`/`assignOwner`), and destructive or outward-facing
actions (deleting items, sending comms, marking an event Ready) stay
human-confirmed.

### P11. One playbook for humans and agents
The agent.md shouldn't be a hidden prompt — it's the chapter's operating
manual. Humans read the same guidance the agent follows ("what should be done
by T-10?"). This argues for the playbook being **content, not code** (see
open question Q3).

---

## 3. Lifecycle improvements (proposed, in rough priority order)

1. **Post-event debrief loop** (biggest missing piece, closes P1):
   cron at T+2 nudges owner + agent opens the retro; agent interviews via chat
   ("what went well / what broke / budget vs actual / attendance"), fills retro
   rows, and generates *proposed template diffs* (new tasks, changed offsets,
   supply qty changes) the user approves per-line. Event auto-prompts
   `completed` after eventDate passes.
2. **Readiness gates + validated transitions** (P4): criteria-based module
   readiness, event Ready gate, warnings with override; auto-suggest status
   transitions instead of silent manual chips.
3. **Feasibility & lead-time checks** (P5): on create/reschedule, flag
   already-late and infeasible items; `minLeadDays` on template items.
4. **Reminder coverage for all modules** (P2): convention-based due dates for
   supplies (T-1), run-of-show lock (T-3), retro (T+7); persist run-of-show
   wall-clock times.
5. **Task timeline view** (already in the Phase-1 design mockup, never
   shipped): one chronological T-minus board across modules — This week / Next
   30 days — with inline assign. This is also the agent's natural "what's next"
   canvas.
6. **Assignment checkpoint + workload awareness** (P3, P9): T-10 "crew
   locked" gate; bulk-assign; load/rotation warnings at assignment time.
7. **Volunteer self-serve on the share page**: confirm/decline + see own call
   time/tasks via capability link (the `projectEmailTokens` pattern already
   exists — reuse it), so organizers stop hand-cycling status chips.
8. **Dependencies (`blockedBy`)** (P6): template-authored, agent-readable
   critical path.
9. **Weekly per-event planning digest**: "It's T-14 for Eden: 3 tasks due this
   week, comms announce not yet posted, 2 roles unassigned" — email + agent
   chat opener.

---

## 4. Agent design

### 4.1 New tools (from the gap audit)

The assistant today: `update_items`, `update_item`, `add_item`, `find_photos`,
`set_photo` (event) + doc tools. Proposed additions, tiered:

**Tier 1 — core planning verbs (do first)**
- `remove_item` (it literally cannot delete today), wired to the real
  `items.removeEventItem`
- `assign_role` / `unassign_role` → `roleAssignments.assign/unassign`
- `add_engagement` / `update_engagement` (invite/confirm crew, set teams,
  call times) → `engagements.*`
- `add_person` → `people.create` (recruit onto the roster)
- `set_module_owner`, `toggle_module`, `create_custom_module` → `modules.*`
- `get_readiness` (read: phase scores, unassigned roles, unresolved
  placeholders, overdue items) — the agent's situational-awareness call

**Tier 2 — lifecycle & worship-specific**
- `reschedule_event` (with feasibility report), `set_event_status`
  (gate-checked)
- setlist/songs: `add_song_to_setlist`, `reorder_setlist`, `set_requests_open`,
  song-library search — worship-specific and entirely invisible today
- `mark_module_ready` — only as a *proposal* the human confirms (P10)
- `create_event_from_template` — requires a chapter-level assistant surface

**Tier 3 — cross-event intelligence**
- `get_person_load` (concurrent events, recent role history)
- `search_past_events` (retro learnings, actual costs, what T-offsets slipped)
- template patching: `propose_template_change` (the P1 debrief loop)

### 4.2 The agent.md playbook

Structure (one file, sections retrievable individually):
1. **Identity & north star** — sage for public worship events; zero tribal
   knowledge; propose-then-apply.
2. **The planning philosophy** — P1–P11 above, condensed.
3. **Phase playbooks** — what "good" looks like and what to nudge at each
   window: kickoff (T-∞→T-14), build (T-14→T-7), lock (T-7→T-1), day-of (T-0),
   debrief (T+1→T+7). Derived directly from Eden/WWS task lists.
4. **Module-by-module best practice** — permits lead times & who-must-attend;
   comms cadence table; supplies packing/source/storage conventions and the
   charge-the-battery rule; run-of-show segment archetypes (load-in, soundcheck,
   huddle+prayer, worship sets, gospel, giving charge, strike/leave-no-trace);
   volunteer team shapes (Welcome 6, Flower 2, Food/Bev 2, Prayer, Content).
5. **Tool discipline** — batch edits, exact option values, reference ids,
   verify after write, summarize changes, never mark ready/send comms without
   confirmation.
6. **Human guide** — the same playbook phrased for the chapter lead (this can
   simply be the same sections; P11).

**Token budget caveat:** the assistant runs free OpenRouter models with 4k
output and a 12-step loop. A monolithic agent.md baked into every system
prompt is expensive/fragile there. Recommendation: a **two-layer prompt** —
~40 lines of core rules always present, plus phase- and module-relevant
playbook sections injected based on the event's current T-window (the backend
already knows `currentPhase`), with a `get_playbook(section)` tool as
fallback.

---

## 5. Open questions to decide together

- **Q1 — Agent scope.** Keep it event-scoped, or add a chapter-level surface
  that can create events, see the whole pipeline, and check roster load?
  (Recommend: event-scoped first with Tier-1 tools + `get_readiness`, then a
  chapter assistant.)
- **Q2 — Human-in-the-loop boundary.** Which actions need explicit
  confirmation? Proposed: agent free to edit items/assignments (revertible);
  confirm required for delete, mark-ready, status transitions, anything
  volunteer-facing (comms/blasts).
- **Q3 — Where agent.md lives.** (a) repo file compiled into the system
  prompt (versioned with code, not chapter-editable), (b) a `docs` row per
  chapter (editable in-app, AI-assistable, shareable — infra already exists),
  or (c) hybrid: core rules in code, playbook sections as platform-seeded docs
  chapters can override. (Recommend c.)
- **Q4 — Gates: hard or soft?** Recommend soft (warnings + override) except
  where irreversible or outward-facing.
- **Q5 — Volunteer surface.** How much self-serve on the public share page
  (confirm/decline only vs. task check-off too)?
- **Q6 — Model reality.** The playbook assumes decent tool-calling; free
  models are flaky (fallback chain exists for a reason). Do we accept paid
  models (Sonnet) for the planning agent behind the existing budget system?

---

## 6. Explicitly out of scope for the first pass

- Multi-chapter switching / chapter cloning (V3 per README).
- Shared inventory across events (storage contention) — noted as P-adjacent,
  not blocking.
- Real-time collaborative planning.
