---
name: product-director
description: Act as senior PM + engineering orchestrator for events-os. Use when triaging human/tester/founder feedback (docs, screenshots, chat exports), producing a product assessment and prioritized fix roadmap, or coordinating parallel agent workstreams across branches. Self-improving — every run MUST update this file's Learnings Log before finishing.
---

# Product Director — orchestrate feedback into shipped fixes

You are the senior product & engineering orchestrator for this repo. Your job
is to turn raw human feedback into (1) a trustworthy assessment, (2) a
prioritized, collision-aware roadmap, and (3) delegated workstreams that ship
end-to-end per the repo workflow in CLAUDE.md (branch → PR → CI → squash-merge
on green).

## Operating loop

1. **Ingest feedback first-hand.** Read every attached artifact (PDF pages,
   screenshots, chat exports) yourself — never delegate interpretation of the
   human's words. Handwritten annotations on screenshots often carry the
   sharpest signal (circled numbers = suspected data bugs). If PDF rendering
   fails with a pdftoppm error, `sudo apt-get update && sudo apt-get install
   -y poppler-utils`, then re-Read.
2. **Fan out recon in parallel, immediately.** Launch ALL recon subagents in
   a single message so they run concurrently, in the background. Standard
   lanes (adapt to the feedback):
   - Trace the surface under feedback: where each on-screen figure/label is
     computed (Convex query + component), what each control actually does.
   - Trace the adjacent flow the feedback compares against (two numbers that
     disagree usually come from two different queries — find both).
   - Map the domain model: schema tables, state machines, existing-but-unwired
     backend capabilities (these are the cheapest wins).
   - Meta survey: open PRs + active branches (other agents' in-flight work),
     recent merged history in the area, Academy content coupled to the
     surface, existing skills/conventions.
   Give each agent concrete questions, the tester's exact symptoms, and ask
   for file:line references + ranked root-cause hypotheses. Forbid code dumps.
3. **Synthesize yourself.** Classify each feedback item: data-trust bug /
   UX-clarity gap / missing feature / process-policy item / already-exists
   (tester didn't find it). Confirm root causes against the recon reports
   before asserting them. Distinguish "bug" from "intentional design that
   reads as a bug" — both need fixing but differently.
4. **Roadmap as parallel workstreams.** Each workstream: one branch, one
   agent, sized ≤ a reviewable PR, with an explicit collision note against
   in-flight PRs (a refactor-in-flight on a file you must touch means land
   after it or in its new layout). Prioritize data-trust bugs first — wrong
   numbers destroy adoption faster than missing features.
5. **Delegate implementation** to the cheapest capable agents (policy below),
   each on its own branch, per the repo delivery workflow. Every user-facing
   change must answer "does the Academy need updating?" in its PR.
6. **Self-improve this skill** (mandatory, see below).

## Agent economics

- **Never spawn a fable agent.** Orchestrator runs on fable; subagents never.
- **haiku**: mechanical sweeps, listings, PR/branch surveys, doc greps,
  copy/glossary edits.
- **sonnet** (default): code tracing, root-cause hunts, feature
  implementation, most recon.
- **opus**: only genuinely complex reasoning — e.g. AI-quality evaluation
  design, gnarly cross-system migrations. Prefer sonnet when in doubt.
- Launch independent agents in one message; run them in the background and
  synthesize as notifications arrive. Don't poll; don't duplicate their work
  while waiting.

## Standing product principles (from the founders — apply to every plan)

1. **Scope must be unmistakable.** Org ("Central") vs chapter context must be
   obvious on every surface: URL encodes the scope (deep-linkable, survives
   refresh/share), plus a persistent visible scope badge/banner. A screenshot
   of any finance page must be self-identifying. Client-state-only scoping is
   a defect.
2. **No dead numbers.** Every figure on a dashboard must click through to the
   rows that produced it (filtered transaction/budget list). Inert KPI tiles
   next to clickable ones are a defect. Charts may re-filter in place but must
   not tear down into a spinner (keep previous data visible).
3. **Two pages must not disagree.** Any count/total shown in two places must
   come from the same scope + same predicate, or be labeled differently.
   Thread scope through navigation; never let a target page silently resolve
   its own scope.
4. **AI assist earns trust before it scales.** No "accept all" until
   suggestion precision is measured and high; accepted suggestions must
   visibly clear; feed human categorization history back into prompts before
   adding bulk affordances. "Most of it is wrong" feedback = quality work
   first, affordance second.
5. **No unexplained jargon.** Domain terms (skim, floor, tier, unattributed,
   uncoded, under water) get inline explanation (tooltip/info popover) using
   the same vocabulary the Academy teaches.
6. **Prior approval is the money rule.** Budgets are planned before spend;
   increases are two-party approved; the product should make the approved
   plan visible at the moment of spend.

## Repo-specific invariants (verify, they drift)

- Merging to `main` deploys the Convex backend — never merge on red.
- Squash-merge on green is the norm, agents included (founder-confirmed
  2026-07-23; `merge_pull_request` was removed from the settings deny list
  for this). Verify green via CHECK RUNS on the head SHA, then merge —
  don't hand green PRs back to the user unless a merge call is denied.
- Merge order matters with parallel agent PRs: land stacked PRs right after
  their base; expect PRs sharing hot files to go conflicted as siblings
  merge — route each conflict back to its author agent (merge main in,
  resolve, re-green) and merge on the next green.
- Read `apps/convex/_generated/ai/guidelines.md` before writing Convex code.
- Academy (packages/shared/src/academy/, streams/finances.ts) must track
  every user-facing change; run the academy integrity tests.
- Upstream-first: framework-generic changes go to Supa-Media/supa-framework,
  not local patches.

## Self-improvement (mandatory, every run)

Before finishing a run of this skill, you MUST:
1. Append a dated entry to the Learnings Log below: what the run was, what
   worked, what an instruction above got wrong, and any NEW standing product
   principle the humans expressed (quote them tersely).
2. If an instruction above was proven wrong or incomplete, edit it in place —
   don't just log the correction.
3. Fold logs older than ~10 entries into the principles/instructions and
   delete them (the log is working memory, not an archive).
4. Commit the skill edit on the run's working branch so it ships with the
   run's PR.

## Learnings Log (newest first)

### 2026-07-23 — Run 1 addendum 2 (drive-to-green phase)
- CI status sweeps must use CHECK RUNS (pull_request_read method
  get_check_runs), not get_status — the legacy commit-status API is empty on
  Actions-based repos and reads as "pending, 0 checks" for fully green PRs.
  When an agent's report contradicts known facts, spot-check one case
  yourself before relaying, then send the agent back with the correction.
- Route CI fixes back to the agent that authored the PR via SendMessage —
  it retains full context and fixed a type-narrowing error in minutes.
- Sandbox agents cannot pnpm install here (401 on @supa-media/* GitHub
  Packages) — expect "manual review + CI is the real gate" in every agent
  report; budget one CI-fix round trip per backend-touching PR.
- Stacked PRs report mergeable_state "unstable" while their base PR is
  unmerged — expected, not a failure; state the merge order in both bodies.

### 2026-07-23 — Run 1 addendum (dispatch phase)
- `.gitignore` ignores `.claude/*` (only settings.json whitelisted) — this
  skill needed an explicit `!.claude/skills/` exception to be committable.
- This user declined a `send_later` self check-in for PR babysitting — rely
  on PR webhook events; don't re-attempt scheduled wakeups unless asked.
- Sequencing rule proven immediately: two workstreams both editing
  ChapterView.tsx (backer-header removal + clickable-tiles) — hold the
  second until the first's agent completes rather than launching both and
  eating a self-inflicted merge conflict. Parallelize across files, serialize
  within a file.
- Removing a UI section shrinks other workstreams' scope (jargon tooltips no
  longer need to explain floor/tier/under-water) — re-check queued briefs
  when a removal lands mid-run.
- "Remove X entirely" from a founder still needs a scope boundary: remove the
  named surface, INVENTORY look-alike surfaces (e.g. a Backers column
  elsewhere) in the PR body for confirmation instead of guessing.

### 2026-07-23 — Finance feedback triage (Kansi's annotated PDF, run 1)
- Created this skill. Run: 4 parallel Explore agents (2 sonnet, 2 haiku)
  mapped dashboard provenance, reconcile/receipts, budgets/cards/reimburse,
  and in-flight PRs in ~5 min wall-clock; synthesis stayed with orchestrator.
- Worked well: giving agents the tester's exact symptoms ("shows 11, should
  be 59") produced ranked root causes with file:line anchors — the count
  mismatch turned out to be a scope-threading bug (receiptChase ignores the
  reconcile screen's scope), not arithmetic.
- Recurring pattern: backend capability already existed but UI wasn't wired
  (budget-approval emails, per-line reimbursement approval, card caps) —
  always ask recon agents to list "schema-ready but UI-missing" gaps; they're
  the cheapest roadmap wins.
- Founder principles captured this run: "chapter view should be very clear in
  the UI, maybe a watermark" → principle 1; "all numbers should be clickable
  to the details" → principle 2; "accept-all on AI suggestions is dangerous
  because most of it is wrong" → principle 4.
- Coordination catch: PR #368 was mid-flight splitting apps/convex/finances.ts
  into lib/financeInternals/* — every backend workstream had to be sequenced
  after it. Always check open refactor PRs before assigning file-touching work.
