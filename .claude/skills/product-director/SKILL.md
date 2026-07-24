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
- Launch independent agents in one message and run them in the background.
- **Poll every 5 minutes, always (founder directive 2026-07-24).** Never
  passively wait for completion notifications and never just trust a
  subagent's self-report: while ANY subagent, CI run, or deploy is
  outstanding, keep a 5-minute send_later check-in armed that (a) checks
  each in-flight branch for new commits (`git fetch` + `git log`), (b)
  checks CI/deploy runs on open PRs, (c) spot-verifies subagent claims
  against the actual repo/CI state, and (d) re-arms itself. Notifications
  are a bonus wake-up, not the mechanism. Don't duplicate agents' work
  while waiting — verify outcomes, don't redo them.
- **Polling mechanism — persistent Monitor ticker, NOT send_later (founder
  directive 2026-07-24).** Arm ONE session-length ticker at the start of any
  run with in-flight work: Monitor with `while true; do sleep 300; echo
  "POLL TICK"; done`, persistent: true. Each tick = run the full poll cycle
  above. **NEVER use send_later — for polling or anything else (founder
  directive 2026-07-24: "it blocks unnecessarily").** Every call throws a
  blocking permission dialog on claude.ai/code (the repo allowlist is
  ignored for CCR scheduling tools) and interrupts the founder. Monitor
  covers timed wake-ups; Bash run_in_background with an `until` loop covers
  one-shot waits. Stop the ticker (TaskStop) when nothing is outstanding.

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
7. **Consent is non-negotiable in comms.** Every bulk email carries a
   working one-click unsubscribe from send #1; transactional email
   (verification, receipts, approvals) is never gated by it. No BCC blasts,
   ever — "people can't unsubscribe yet" is a compliance and deliverability
   defect, not a convenience. Suppression (bounce/complaint/unsubscribe) is
   shared org-wide; list membership is granular.
8. **No SaaS silos for data the platform owns.** When Chapter OS already
   holds the contacts (donors, RSVPs, roster) and is ≥80% of the way to a
   capability, don't stand up a vendor tool (Mailchimp etc.) that forks the
   contact list — chapters especially must not create their own accounts.
   "Rhythm before metrics" is a fine cultural rule (founder-endorsed:
   consistency for the first months beats dashboard-watching), but the
   system records metrics from send #1 regardless — collecting ≠ watching.

## Repo-specific invariants (verify, they drift)

- Merging to `main` deploys the Convex backend AND triggers separate
  production deploys: `Deploy Web (production)` and `Deploy Mobile Update
  (OTA)`. These run the Metro bundler, which the PR's CI (unit tests +
  typecheck) does NOT. So a PR can be fully green and still break the web +
  mobile deploys — never assume "CI green" == "deploys will pass." After
  merging finance/mobile UI changes, verify the post-merge Deploy Web and
  Deploy Mobile OTA runs on `main` actually succeed; if red, hotfix
  immediately (the backend deploy is independent and usually still fine).
- Bundler-only failure class to pre-empt: unresolved/mis-depthed relative
  imports. When two PRs edit the same file's import block (a rebase/merge
  reconciliation), grep the merged file for relative-import depth mistakes
  (`../ui` vs `../../ui`) before merging — the sandbox can't run the bundler
  (`pnpm install` 401s on `@supa-media/*`), so tsc/vitest won't catch what
  Metro will. This exact bug (CategoryBars `../ui` → `../../ui`) broke both
  production bundles on 2026-07-23 after #381×#389 merged.
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

### 2026-07-24 — Run 2 addendum 6 (Phase 3 #407 shipped — workstream complete)
- Full email workstream shipped in one session-day: #323 revival → #399
  approval gate → #401 identity backbone → 0039 hotfix (#405) → #402
  personEmails → #407 audience picker. Pattern that converged: implement →
  adversarial-verify (empirical probes) → consolidated fix round → local
  full suite before push → PR → CI → squash-merge → verify deploys.
  Local-suite-first made #402 and #407 first-try-green in CI.
- Deploy-Convex runs migrations:runPending POST-deploy: a migration can
  pass convex-test + CI and still fail prod (single-paginate rule is
  unenforced locally — 0039). Deploy verification caught it; user impact
  zero because the resolver had a designed fallback. Every migration now
  needs the one-paginate-per-invocation review, and resolvers use bounded
  take/collect scans only.
- Same-day feature collision class: #399's snapshot hash didn't know about
  #407's new hand-pick fields — verifier's cross-feature probe caught the
  approval-integrity hole (post-approval hand-pick edits sailed through).
  When two features land same-day on one surface, have the LATER PR's
  verifier explicitly probe the EARLIER feature's invariants against the
  new fields.
- Founder ops directives now encoded: 5-min Monitor-ticker polling (never
  send_later — blocks with permission prompts), never trust subagent
  self-reports (verify against repo/CI), docs in CLAUDE.md + this skill.
- OUTSTANDING for a future run: manual 0037 guest backfill in prod (founder
  triggers; dry-run first) — until it runs, legacy guests audiences stay on
  the legacy resolver (0040 deliberately skipped them); after it runs,
  migrate them and retire the legacy resolvers. Also upstream candidates
  per upstream-first: Monitor-ticker guidance → supa-framework claude
  template; generic email-send primitive → @supa-media/convex.

### 2026-07-24 — Run 2 addendum 5 (Phase 2 personEmails #402 shipped)
- pnpm vitest + tsc NOW WORK in the cloud sandbox (the 401-on-install
  constraint lifted mid-session). Require implementation agents to run the
  full suite + tsc locally BEFORE pushing — Phase 2 was this session's
  first first-try-green CI, vs 4 fix rounds for the blind-push approval PR.
  Verifiers should run empirical probes too (Phase 2's verifier proved
  no-unsubscribe-bypass by executing the resolver, not reading it).
- Write-through-ledger failure class: when adding a mirror table
  (personEmails) maintained at mutation sites, the classic misses are
  admin MERGE flows (blank-fill), LOGIN-time reconciliation, and AI/tool
  insert paths — and BOTH repoint-references helpers must learn the new FK
  table or merges orphan rows. Audit those four site classes explicitly.
- Suppression invariant held as designed: resolve ONE send address per
  person, check that one string against suppressions — never retry
  per-address (that would route around an unsubscribe).

### 2026-07-24 — Run 2 addendum 4 (Phase 1 identity backbone #401 shipped)
- Contact/roster boundary needed THREE audit layers to get airtight:
  implementer's own audit → adversarial verifier (found 3 leaks + the
  docs-vs-code stamping gap) → systematic grep sweep (found 1 more leak +
  4 judgment calls). For boundary-type changes (a flag every consumer must
  respect), budget all three layers; none alone sufficed.
- Verifier ran tests EMPIRICALLY this round, including a throwaway
  origin/main git-worktree comparison — far higher signal than static
  reading (it proved a "regression" reproduced only on-branch). Encourage
  verifiers to attempt running the real suite; the pnpm/401 constraint may
  not bind in all sandboxes — but require they leave the tree clean.
- Grandchild-sweep pattern: implementation agent spawned its own sweep
  whose report bubbled to the orchestrator; ruling on its judgment calls
  centrally (fix vs deliberately-inclusive-with-comment) and sending
  rulings back worked well — boundaries get ONE consistent policy.
- New failure class: side-effectful helpers at insert sites flip pinned
  import-preview expectations (canonicalImport donorMatch "new"→"email").
  When adding insert-time side effects, grep tests for pinned preview/
  disposition expectations on flows that traverse those inserts.
- "Leave inclusive" sites must carry a comment stating the decision, or a
  future sweep will "fix" them backwards (matchPerson SOD binding,
  dataHygiene dedup).

### 2026-07-24 — Run 2 addendum 3 (approval gate #399 shipped; audience recon)
- Approval-gate PR took FOUR CI/verify fix rounds (typecheck narrowing →
  pinned seat spec → pinned migration registry + email-block placement →
  missing link anchor + zero-recipient test). Rounds shrink but budget ~3-4
  for a 3.5k-line feature PR, not 1.
- Adversarial verifier with recon-informed prompts caught a REAL SOD bypass
  (one userId owning two people rows self-approving via its second row) that
  the implementation agent's own tests missed — always prompt verifiers with
  the specific bypass classes the domain allows (multi-row identity here).
- Pinned-spec test class: adding seat capabilities breaks
  packages/shared/src/seats.test.ts EXPECTED_CAPABILITIES_BY_SEAT; adding a
  migration breaks apps/convex/tests/migrations.test.ts REGISTRY_NAMES. Sweep
  ALL pinned specs (grep toEqual on shared constants) when touching seat defs
  or migrations.
- Email-link assertions need process.env.APP_URL set in the test (no repo
  precedent existed — house pattern was asserting context data, not HTML).
  Conditional-link house pattern (`link ? <a> : ""`) silently ships CTA-less
  email when env is missing — degrade loudly instead.
- Founder direction captured: person-centric audiences (source is ALWAYS
  people; donor/guest→person linkage; personEmails + prefs; filters incl.
  giving amount/backer/attended-event; hand-picked include/exclude lists;
  suppression overrides hand-picks). Full design: specs/person-centric-audiences.md
  — phases there are the roadmap of record.

### 2026-07-24 — Run 2 addendum 2 (dispatch → merged: #323 revival shipped)
- Full arc in one run: recon → founder greenlight → revival agent (merge
  main into 62-behind branch) → adversarial verify agent → 2 fix commits →
  squash-merge #323 → all 5 post-merge deploy runs green. Reviving a
  well-built stale branch beat rebuilding: ~2h wall-clock for a 12k-line
  feature.
- subscribe_pr_activity failed repeatedly ("Could not subscribe") on both
  tool variants — fallback that worked: send_later check-ins (~6-8 min)
  carrying explicit next-step instructions. The prior "user declined
  send_later" learning is about unprompted babysitting; when the user says
  "merge ASAP" and webhooks are broken, scheduled check-ins are the tool.
- Merge-conflict failure class worth naming: git interleaves two
  structurally-similar-but-distinct blocks (route pairs in http.ts, settings
  fns, mobile cards) into one hunk. Instruction that worked: RECONSTRUCT
  from verbatim parent-tip sources (`git show parent:file`), never trust the
  raw diff; then have a separate verifier byte-compare each reconstructed
  block against its originating parent.
- Two defects escaped the (excellent) revival agent, caught by cheap layers:
  (1) typecheck drift — main added a NEW call site (sendSignInPhoneCode) of
  a function whose signature the branch widened; textually conflict-free,
  CI caught it. Budget one CI round trip for exactly this class. (2) a
  behavior bug (digest email subject ternary duplicated from the h1) found
  only by the adversarial verifier's parent-diff spot-read — verify agents
  earn their cost on merges; run them in parallel with CI, not after.
- Orchestrator fixing 1-line CI/verifier findings directly beats
  round-tripping to the author agent when the diagnosis is already in hand
  — reserve SendMessage round trips for fixes needing the agent's context.
- Retarget a stacked PR's base to main BEFORE the revival push (one
  update_pull_request call), and close the superseded base PR with a
  contained-in note.

### 2026-07-24 — Run 2 addendum (team chat: Mailchimp vs BCC vs native)
- Team exchange (Charisma/Carolyn/founder) surfaced principles now encoded
  as 7 & 8 above: founder rejected BCC ("filters to spam", can't design),
  leaned build-native over Mailchimp $20/mo ("pricing is brutal… build it
  myself"); Carolyn's "consistency first 3 months, metrics later" endorsed
  as culture but NOT as "skip unsubscribe" — the team briefly framed
  no-unsubscribe as a feature of BCC; guidelines must preempt that framing
  org-wide before chapters multiply.
- Ops reality check for native sends: Resend free tier is 100 emails/day —
  a 500-recipient newsletter needs a paid Resend plan (~$20/mo) or
  multi-day batch pacing; cost-parity with Mailchimp, so the native
  argument is data unity + control + chapter scale, not price.
- Contact compilation ask ("Givebutter + any other emails") = the donors/
  rsvps/people silos recon already mapped; a mailing-list import must
  record provenance + set expectations in the first send.

### 2026-07-24 — Run 2: email-list/newsletter readiness assessment
- Run shape: founder asked "what's the state of X, how ready are we" — an
  assessment run, no attachments. 4 recon lanes (branch archaeology, main
  inventory, framework capabilities, PR history) in one parallel launch;
  synthesis-only deliverable, no implementation dispatched unbidden.
- "I think I had a branch for this" → check OPEN PRs first, not just
  branches: the remembered work was two still-open stacked PRs (#322→#323,
  a complete ~12k-line campaigns system), not a rotted branch. PR-history
  lane found intent/state; git lane found mergeability.
- Git archaeology mechanics: the cloud clone is SHALLOW — `git fetch
  --unshallow` before any merge-base/ancestry work, else false "no merge
  base". `git merge-tree --write-tree origin/main <branch>` gives a
  conflict-file list without touching the working tree — cheap, decisive
  staleness evidence (62 behind / 9 conflict files ≠ "rotted").
- Recon lanes disagree usefully: framework lane said "no email infra
  upstream", branch lane said "branch built lib/resend.ts app-local" —
  that intersection IS the upstream-first decision to surface, not resolve
  silently.
- Product gap worth naming precisely: #323's unsubscribe = deployment-wide
  suppression (transactional exempt — matches founder ask) but NOT
  per-list; founder said "mailing lists" plural. Flag granularity deltas
  between remembered work and current ask explicitly.

### 2026-07-23 — Run 1 addendum 3 (post-merge deploy break)
- Green CI is NOT green deploys. 10 PRs merged green, but two of them
  (#381 tooltip import + #389 dashboard edit to the same file) combined into
  a mis-depthed relative import (`../ui` should have been `../../ui`) that
  only the Metro bundler catches — CI's unit/typecheck jobs don't bundle.
  Result: `Deploy Web (production)` + `Deploy Mobile Update (OTA)` failed on
  main while Convex deploy + CI stayed green. Hotfix #391 fixed it; verified
  by checking the post-merge deploy workflow runs, not just CI.
- Takeaways now encoded as invariants above: (1) always verify post-merge
  Deploy Web/Mobile runs for UI changes; (2) when a merge reconciles two
  PRs' imports, grep the file for import-depth mistakes before merging.
- Mechanic: `actions_list` on main can exceed the token cap — slice the
  saved tool-result file with python `read()[A:B]` and parse the JSON for
  `name|conclusion|head_sha` instead of reading raw.

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
- [SUPERSEDED 2026-07-24 by the poll-every-5-minutes directive above — the
  founder now REQUIRES scheduled polling; webhook subscription was broken
  all session anyway.]
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
