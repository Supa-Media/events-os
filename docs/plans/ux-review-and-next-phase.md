# UX review & next-phase brief (founder review, 2026-07)

## Why this doc exists

Phases 1–3 shipped the **foundation only** — canonical vocabulary, tier-derived
navigation, a full legacy-schema purge, a self-applying migration pipeline, and
a fix for the (previously never-running) shared CI. Deliberately low on visible
change. The founder (`dev@supa.media`) then did a hands-on walkthrough of the
live app and surfaced a batch of UX problems plus the appetite to finally build
the "exciting" roadmap (Central, Giving, Run of Show, Permits, typed Inventory,
Academy restructure).

This doc captures that review as a **brief for a fresh implementer**. Every item
is a **problem statement, not a spec** — the implementer is expected to
interrogate it, propose a design with rationale + alternatives, and get buy-in
**before** building. Several items below explicitly push back on Phase-2
decisions (no Home tab, Mine-in-Events, Templates-as-a-pillar); those were
deliberate, so they must be *re-decided with the founder*, not silently kept or
silently overturned.

**Prior working method (keep it):** implement → independent adversarial verify →
PR on the now-working shared CI → human merge, paced. Small, reviewable PRs.
Migrations are numbered files in `apps/convex/migrations/` applied by
`runPending` on deploy (ledger-backed). See
`docs/plans/chapter-os-rebrand-and-schema-clarity.md` and
`docs/plans/chapter-playbook.md` for the settled vocabulary and the
Central/Playbook design.

---

## A. Branding — actually rename Events OS → Chapter OS

The app still self-identifies as **"Events OS"** (onboarding/splash brand marks,
page titles, first-run copy). The product is **Chapter OS**. Rename the
user-facing brand everywhere it appears. Package/repo names can stay code-only.
(This was named as a decision earlier but never executed in the UI.)

## B. Per-surface UX problems (from the walkthrough)

### Events (the home surface)
- A **"people card"** shows on the Events page for no clear reason — audit why
  it renders there; likely remove or justify.
- An **"Upcoming" card** duplicates the already-visible upcoming-events list —
  redundant.
- **"Mine"** works, but feels out of place *inside* Events. Reconsider where
  per-user "my work" belongs. **This reopens the Phase-2 "no Home tab" decision**
  — Phase 2 deliberately dropped a Home tab and put "Mine" in Events; the founder
  is now questioning that. Re-decide the home/landing IA.

### Templates
- Templates are a **top-level side-panel pillar**, but templates only exist to
  drive events → **move Templates into the Events surface** (a section/mode of
  Events), not a separate pillar.

### People
- Needs a **general redesign**. Opens on "all people"; the founder expects to
  **start filtered by Team** (the common case). Rethink the default view +
  filtering model. (The deferred People + Org-chart merge folds in here.)

### Work / Duties / Projects
- "Work" tab is fine, but **"Duties" is hidden**, and opening Duties renders
  **Work and Duties overlaid on top of each other** — a real UI **bug** in the
  segmented control; fix it.
- Projects + Duties need a **better representation** than the current toggle.
- **Projects have no detail page.** The reminder email lists due items but links
  nowhere. Projects need **their own pages**: open a project, see/add comments,
  change status, etc. Backend largely exists (`projectComments`, status) — the
  **UI route is missing**. This is a genuine gap, not a nicety.
- On an **individual person**, there's **no way to edit their duties** /
  assignments. Add per-person duty management somewhere sensible (person profile).

### Songs / Inventory
- Songs is in the nav. **Inventory** (discussed as Phase-5 M5.5) has **no home** —
  decide where it lives (chapter-level asset registry + per-event reservations;
  ties to the Chapter Kit concept in `chapter-playbook.md`).

### Academy — the biggest redesign ask
Current: one flat section listing all sections, plus a **list of who's trained
printed on the record** (founder: this doesn't make sense).

Desired model:
- Academy is **not just for events** → **section by theme**: Events courses,
  Management, Leadership, team tracks, etc.
- Courses have **levels**: beginner / intermediate / advanced / becoming-a-leader
  (and parallel tracks for management, leadership…).
- Courses contain **curriculum modules**.
- Completion is **"I passed this course"** represented as a **badge**, NOT a
  list-on-a-record:
  - On a **course**: see who has completed it.
  - On a **person's profile**: badges for every course they've completed.
This supersedes the current flat Academy + trained-people-on-record model. It
also connects to the role/ownership/team course taxonomy sketched in the rebrand
plan §5a — reconcile the two.

### Chapter vs Central identity
- It's **not clear** whether the logged-in user is Central or a chapter, or **how
  to manage a chapter**. The Central/chapter model (PW Central) must be **legible
  in the UI** — current context/role, and a chapter-management surface. This is
  the on-ramp to the whole Phase-4 Central/Playbook build.

## C. Next-phase features (the roadmap the founder wants built — design-first)

Full designs already exist; treat them as starting points to interrogate, not
gospel. Sources: `chapter-os-rebrand-and-schema-clarity.md` (§5 Central, §7 typed
domain) + `chapter-playbook.md`.
- **PW Central + Chapter Playbook** — chapter identity/provisioning, playbook
  releases + subscribe/drift + upstream proposals, the Launch Track, the Chapter
  Kit. (Answers the "am I Central or a chapter?" problem in B.)
- **Giving** (M5.1) — donations on the Event page. Self-contained, no deps; the
  best first *visible* win.
- **Run of Show** (M5.2) — typed segments, call times, a required event
  start-time anchor.
- **Permits** (M5.3) — typed permits + required fallback plan; wire into readiness.
- **Budget** (M5.4).
- **Inventory** (M5.5) — assets + reservations; materializes the Chapter Kit.

## D. Sequencing guidance for the implementer

Most of section B is **information-architecture / model** work, not screen
tweaks. Recommended order:
1. **IA + identity pass first** — resolve the cross-cutting model questions with
   the founder: the home/landing question (does the no-Home-tab decision hold?),
   Templates-in-Events, Central-vs-chapter legibility, and the Academy model
   (themes → courses → levels → modules → badges). These gate the screens.
2. **Fix the concrete bugs** — the Work/Duties overlay; the missing Project
   detail page; the missing per-person duty editing; the stray Events cards; the
   Events OS → Chapter OS rename. These are shippable now and give visible wins.
3. **Then the roadmap features**, Giving first (visible + self-contained), the
   Central/Playbook build alongside the identity work from step 1.

Do NOT batch these into one mega-change. Each is its own designed, verified,
reviewed PR.
