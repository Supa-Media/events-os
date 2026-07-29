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
3. **Synthesize yourself.** When the feedback REFERENCES A SPECIFIC ARTEFACT
   (an existing newsletter, a screenshot of a competitor, "make it look like
   this"), your first move is a DIFF TABLE against that artefact, before any
   design: every distinct background fill, every card/section treatment, every
   column ratio, every button style, the type scale and tracking, and which
   images are decoration versus which carry text. Ship the table as the spec.
   Building a capability that *could* express the artefact is not the same as
   reproducing it — a generic framework with the right hex values in it reads
   as "nothing like this" to the person who made the original, and that is a
   correct verdict, not a fussy one.
   Classify each feedback item: data-trust bug /
   UX-clarity gap / missing feature / process-policy item / already-exists
   (tester didn't find it). Confirm root causes against the recon reports
   before asserting them. Distinguish "bug" from "intentional design that
   reads as a bug" — both need fixing but differently.
   **Never assert a capability is ABSENT from a recon lane's silence.** A lane
   that traced subsystem X answers only for X's path. "There is no card rail,
   only Increase/ACH" was told to the founder AND baked into an agent brief on
   the strength of a *reimbursement-payout* trace — the repo had Stripe
   Checkout (`stripe.ts`, webhook in `http.ts`, `@stripe/stripe-js` in mobile)
   the whole time, and the founder had to correct it. An absence claim needs
   its own repo-wide grep for the whole category (every payment/auth/email
   provider), not the absence of a mention in one subsystem trace.
   **When the founder's ask is directionally ambiguous, ask BEFORE dispatching
   implementation.** "mark as personal expense … put in their credit cards to
   reimburse for it" had two opposite money-flow readings, each mapping to a
   different already-built subsystem. One AskUserQuestion before dispatch is
   far cheaper than a wrong build. Make each option's CONSEQUENCE concrete,
   not just its mechanism ("status is mutually exclusive, so marking personal
   would un-reconcile the row") — a founder who picks against your
   recommendation on an abstract framing tends to reverse once the concrete
   consequence surfaces, and the reversal costs a rebuild.
4. **Roadmap as parallel workstreams.** Each workstream: one branch, one
   agent, sized ≤ a reviewable PR, with an explicit collision note against
   in-flight PRs (a refactor-in-flight on a file you must touch means land
   after it or in its new layout). Prioritize data-trust bugs first — wrong
   numbers destroy adoption faster than missing features.
5. **Delegate implementation** to the cheapest capable agents (policy below),
   each on its own branch, per the repo delivery workflow. Every user-facing
   change must answer "does the Academy need updating?" in its PR.
6. **Adversarially self-review BEFORE opening the PR — mandatory for every
   feature workstream, not just ones that feel risky.** Fan out review agents
   in ONE message, each with a distinct lens, each told to *find real bugs*
   and to prove every finding by running code rather than by reading. Lenses
   that have each earned their place by finding something a green test suite
   did not:
   - **Correctness/security of the shared layer** — injection into every sink
     (attributes AND `<style>`/CSS, where HTML entities are NOT decoded so
     escaping is the wrong tool), escaping order, arithmetic verified against
     an independent implementation, total functions fed hostile input.
   - **Backend** — auth gate on EVERY new function, guideline violations
     (`.filter()`, unbounded `.collect()`, `.collect().length`), transaction
     read/write limits, OCC contention (a read set that overlaps the write
     set on a hot path), and idempotency/retry paths.
   - **UI** — parity between inline validation and the server validator in
     BOTH directions; a UI that permits what the server rejects silently
     breaks autosave for the whole document, not just that field.
   - **"Does it actually do what it claims?"** — for EVERY new backend
     function, find its production caller; anything reachable only from tests
     is a finding. Its TWIN, equally load-bearing: is the function reachable
     only from a screen that THROWS for the persona it was built for? A caller
     that exists but can never send the argument that matters (a `doc` no
     screen can produce) is the same defect wearing a disguise.
   - **Access-ladder changes** — whenever a rung is added BELOW an existing
     one, two sweeps are mandatory. (a) Grep every call site of the gate the
     new rung now satisfies and classify each as read or write: a visibility
     check that was a *correct* authorization check only because visibility
     implied the higher rung silently becomes an escalation. (b) Grep the
     client-facing access query's RETURN SHAPE — if it doesn't distinguish the
     new rung, every screen renders for a persona whose every write throws,
     and the API-layer tests will all pass while the product is broken.
   Then FIX what they find and re-verify. Treat a subagent's "all green" as a
   hypothesis: re-run the suites yourself.
   **Reviews are not a substitute for CI.** Four review passes missed a
   registered Convex route that the edge router never proxied — every link in
   every sent email would have 404'd in production. No unit test on either
   side could see it; only the repo's cross-package drift assert knew. When a
   change adds a public route, a queue, a cron, or anything else with a
   counterpart in another package, grep for the counterpart explicitly.
7. **Self-improve this skill** (mandatory, see below).

## Agent economics

- **Never spawn a fable agent.** Orchestrator runs on fable; subagents never.
- **haiku**: mechanical sweeps, listings, PR/branch surveys, doc greps,
  copy/glossary edits.
- **sonnet** (default): code tracing, root-cause hunts, feature
  implementation, most recon.
- **opus**: only genuinely complex reasoning — e.g. AI-quality evaluation
  design, gnarly cross-system migrations. Prefer sonnet when in doubt.
- Launch independent agents in one message and run them in the background.
- **Before dispatching review agents, give them ONE ignored path for scratch
  probes and add it to `.git/info/exclude` first.** Reviewers prove findings
  by running code, so they write throwaway tests; crash-safety `git add -A`
  snapshots then sweep those onto the branch. One landed in
  `apps/convex/tests/` this run, where the suite would have picked it up.
- **Briefs must say what has to be TRUE, not only which function to call.** A
  brief that said "route this through `safeEmailHref` like every other href"
  would, followed literally, have deleted the CAN-SPAM unsubscribe link from
  any deployment with no site-URL env var (it collapses a legitimate
  root-relative path to `#`). The agent caught it because it tested the
  outcome. State the invariant; let the agent pick the mechanism.
- **Verify a reported failure before dispatching a fix for it** — two lanes'
  fixes composed without coordination this run, and a flake one lane reported
  had already been cured by another's change.
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
  Monitor's `persistent: true` still times out (~30 min) in this harness —
  expect to re-arm on the timeout notification, every run.
- **Redirecting an in-flight agent: SendMessage is NOT reliable — verify,
  then kill (2026-07-27).** A deep-in-an-autonomous-run subagent may never
  surface queued messages. Two redirects went unread while the agent kept
  building a design the founder had rejected, right down to writing tests
  for it. Protocol: send ONE redirect, then on the very next poll tick
  inspect the worktree for evidence it landed (grep the tree for the
  rejected construct — not the agent's word). If the rejected design is
  still there after one cycle, `TaskStop` and relaunch with a corrected
  brief. A restart costs one build; undetected drift costs the build AND
  the review that has to catch it. Before discarding, diff the dead tree
  for incidental fixes worth salvaging as their own commit (this run
  rescued a real duplicated-`isSpend` cleanup that way).

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
  resolve, re-green) and merge on the next green. Stacked PRs report
  mergeable_state "unstable" until their base merges — expected, not red.
- Git archaeology mechanics: the cloud clone is SHALLOW — `git fetch
  --unshallow` before merge-base/ancestry work. `git merge-tree
  --write-tree origin/main <branch>` gives a conflict-file list without
  touching the tree. Squash-merged source branches NEVER read as ancestors
  of main (`merge-base --is-ancestor` says no forever) — before calling a
  branch "in-flight", compare its tip date and commit subjects against
  recently-merged PRs; recon lanes have twice mislabeled dead source
  branches as collision risks.
- `actions_list` on main can exceed the token cap — slice the saved
  tool-result file with python and parse `name|conclusion|head_sha` instead
  of reading raw.
- Read `apps/convex/_generated/ai/guidelines.md` before writing Convex code.
- Pinned-spec sweep: growing an enum or capability breaks tests that pin
  shared constants — `EXPECTED_CAPABILITIES_BY_SEAT` (packages/shared/src/
  seats.test.ts) on seat changes, `REGISTRY_NAMES` (apps/convex/tests/
  migrations.test.ts) on any new migration. Grep `toEqual` on shared
  constants when touching either.
- Budget ~3-4 CI/verify fix rounds for a large (multi-thousand-line) feature
  PR; a focused client-only fix should be first-try-green off the local gate.
- Prompt adversarial verifiers with the SPECIFIC bypass classes the domain
  allows (e.g. one userId owning two `people` rows self-approving) — generic
  "check this is correct" misses what a domain-aware probe finds.
- Transactional email: assert the real `<a href>` with `process.env.APP_URL`
  set in the test, and make a missing APP_URL degrade LOUDLY — the house
  `link ? <a> : ""` pattern otherwise ships a CTA-less email silently.
- Money state settled by a payment webhook: flip on webhook confirmation
  only (never the browser success-redirect), and route through the existing
  idempotent settle core so retries/out-of-order delivery are one guarantee.
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

### 2026-07-29 — Run 11 (maily.to overhaul: editor replaced, themes retired, templates merged)
- **Whole-system-replacement asks: recon, don't relitigate.** "I kind of hate
  the system we have right now… use maily.to instead" after two rounds of
  editor feedback is a verdict, not a question. The run shape that worked:
  4 recon lanes (library facts from CLONED SOURCE, not docs — the docs 403'd
  and would have been thinner anyway; integration blast radius; artefact
  reproducibility IN THE NEW SYSTEM; meta survey) → synthesis → staged
  parallel workstreams with a contract file written first. The
  reproducibility lane generalizes Run 9's diff-table rule: when replacing a
  system, diff the NEW system's expressiveness against the old system's
  ARTEFACTS (her newsletter), not its feature list.
- **Vendoring a closed dependency is also an audit.** maily's render had no
  extension API, so we vendored it (MIT) — and found THREE upstream bugs in
  the process: two module-level singletons mutated in place (would have
  cross-contaminated per-recipient sends invisibly) and a heading-level crash.
  When the plan already requires owning a file, budget the copy-in as a review
  pass, not a paste.
- **Contract-file-first paid exactly as Run 8 predicted.** `emailDocFormat.ts`
  written by the orchestrator before dispatching the two lanes that shared it:
  zero API-shape rework, vs Run 8's full UI rewrite from a described shape.
- **The orchestrator's own integration review between build lanes and
  adversarial review found the two whole-feature gaps no lane could see**:
  nothing SEEDED the new template (each lane's brief ended at its surface),
  and the Academy taught a deleted product. Per-lane briefs cannot catch
  absences that live between lanes — schedule an explicit "walk the feature
  end to end as a user" pass before review, every large run.
- **"A changed seeder body does not re-run a ledgered migration" — second
  occurrence of the class.** The fix is always a NEW registered migration;
  cron/opportunistic backstops are not deploy-time guarantees (the artwork
  cron self-disables; the opportunistic path waits for a human). Prove which
  mechanism fires, don't assume.
- **git stash in a shared worktree: third incident (WS2b), despite warnings.**
  Promote from war story to brief boilerplate: every implementation brief now
  says NEVER stash/checkout/reset in the shared checkout, and the orchestrator
  verifies surviving-lane files by marker grep after any disclosed mishap.
- **Model economics after an orchestrator model switch**: subagents inherit
  the parent model unless overridden — when the orchestrator moves to fable,
  EVERY Agent call needs an explicit model. The founder audited this
  mid-run; earlier same-night lanes had silently inherited opus.
- **Founder decisions, quoted, now standing product facts:** *"the concept of
  themes is pretty dumb… no need as long as we have templates"* (themes
  retired; brand consistency = start from a template); *"templates should
  literally just be saved emails… like google docs templates… I don't think
  it should be a separate table"* (one table, kind discriminator, gates
  re-anchored on row kind BY DESIGN this time); *"it's okay to only allow
  email editing in the browser"* (web-only editing is the design, not a
  compromise); the maily screenshot = the editing-anatomy spec.
- **Convex+react-email bundling**: `@react-email/render@2.x` ships a `convex`
  export condition and renders in the isolate incl. juice's inliner under the
  edge-runtime harness; the residual risk is import-time `require("fs")` in
  juice under Convex's REAL esbuild — only the first deploy proves it. A new
  workspace package's tests also don't run in the framework's reusable CI;
  the local-job pattern (`router-and-landing`) is the fix shape.

### 2026-07-28 — Run 10 (campaign flow UX + terminology + compliance → PR #462)
- **The headline: a capability rung is not a feature. `myCampaignsAccess`
  returned `{canView, canApprove}` and nothing else, so when I added the
  `campaigns.design` rung, the designer got the desk and every primary button
  threw FORBIDDEN.** My own regression test passed at the API layer while the
  product was broken, because no client could ask the question the backend had
  just learned to answer. **When you add a rung to an access ladder, the FIRST
  follow-up is "what does the client query return, and does it distinguish the
  new rung?"** Grep for the access query's return shape in the same breath as
  the resolver.
- **Widening a visibility gate silently widens every authorization that was
  leaning on it.** `campaigns.ts` gated 19 writes on `requireCampaignsAccess`
  — a *correct* compose gate for as long as desk access implied
  compose-or-above. Adding a lower rung turned all 19 into "any designer may
  do this", plus audience writes and suppression. Nobody wrote a bug; the
  meaning of an existing check changed underneath it. **Before adding a rung
  BELOW an existing one, grep every call site of the gate it satisfies and
  classify each read/write.** This is now the standing rule, not a war story.
- **"Reachable only from tests" has a twin: "reachable only from a screen
  that throws."** The dead-surface lens must ask both — does a production
  caller exist, AND can the persona the feature is *for* actually reach it?
  `updateTemplate` had a caller; the caller could only ever send `name` and
  `description`, so template CONTENT was uneditable and the designer's
  "ownership of templates" was rename/re-describe/archive.
- **Agents in a shared worktree: my crash-safety `git add -A` snapshots swept
  three reviewers' scratch probes onto the branch, and one landed in
  `apps/convex/tests/` where the suite would have picked it up.** Tell review
  agents to write probes under a single ignored path, and add that path to
  `.git/info/exclude` BEFORE dispatching, not after finding one in `git
  status`.
- **A subagent pushing back on my brief was right, and I should design for
  that.** I said "route the unsubscribe URL through `safeEmailHref` like every
  other href"; `siteUrl()` returns `""` when unset, so that would have
  collapsed a legitimate root-relative `/unsubscribe/<token>` to `#` and
  DELETED the CAN-SPAM opt-out from any misconfigured deployment. Briefs
  should say what must be TRUE, not only which function to call.
- **Two lanes' fixes composed without coordination** — a test flake one lane
  reported was already cured by another lane's fix. Verify a reported failure
  yourself before dispatching a fix for it; it may no longer exist.
- **Never read a SKIPPED check as a passing check.** PR #462's Lint job
  reported `skipped`; I confirmed against the last merged PR that this is
  standing framework-workflow config rather than something the PR caused, and
  ran eslint locally anyway. Skipped is absence of evidence.
- **New standing product principle from the founder (2026-07-28), quoted:**
  *"when I think campaign, I think a string of things."* Vocabulary is his
  call, and industry convention is an input, not the answer — I had cited
  Mailchimp's "campaign = one email" as *the* standard when Klaviyo,
  Customer.io, Braze and Iterable all use it for a SERIES. **Check whether the
  convention you're citing is the dominant one or merely the famous one.**
  Corollary he was right about: naming the small thing with the big word burns
  the big word for later.
- **Refusing to merge a green PR can be the correct call.** This PR makes the
  CAN-SPAM postal address mandatory; merging deploys Convex, and the field is
  null in production, so squash-merge-on-green would have taken sending down
  for everyone. The rule exists to prevent self-inflicted outages, not to
  cause them — surface the blocker and get the human's call.

### 2026-07-28 — Run 9 (the same designer: "it looks nothing like this")
- **The headline lesson, and it is a general one: I built a GENERIC FRAMEWORK
  and painted her colours onto it.** Run 8 shipped themes, dark mode,
  templates, polls and an image library — all real, all tested, all merged —
  and the designer's verdict was that it looked nothing like her newsletter.
  She was right. Feedback that says "this doesn't look like us" is a request
  to reproduce a SPECIFIC ARTEFACT, not to build a capability that could in
  principle express it. I had her actual HTML the whole time and treated it as
  a colour reference instead of a specification.
- **What "structural" meant, concretely** — worth keeping because these are
  the categories that generic-framework thinking always misses:
  page/container inverted (cream page + white card, where the real design is a
  grey page + white container with cream as a CARD fill); one card style where
  the design had four; no concept of full-bleed artwork, where the section
  banners CARRY the headings; symmetric columns where the source is 44/56 and
  52/48; one button style where there are filled and outline; browser-default
  letter-spacing where headings are -0.04em.
- **When feedback references an artefact, DIFF against it before designing.**
  Enumerate: every distinct background fill, every distinct card treatment,
  every column ratio, every button style, the type scale and tracking, and
  which images are decoration versus which carry text. That table is the spec.
  I produced exactly that table AFTER being told I'd failed; producing it
  first would have cost twenty minutes and saved the whole rebuild.
- **"No images" was the wrong risk trade, twice.** I refused to ship artwork
  because a hardcoded URL would rot — correct — and concluded the template
  should ship empty, which left something unrecognisable rather than a neutral
  skeleton. Then in the rebuild I reached for a GUESSED placeholder URL and my
  own Run-8 test ("no block references an image URL this deployment doesn't
  own") caught it. The actual answer was a third option: import the assets to
  stable storage (a one-off action, not a registry migration — a MutationCtx
  cannot fetch), and render unfilled slots from theme tokens so an empty state
  costs zero external requests. **When both options look wrong, the framing is
  usually wrong.**
- **Empty states must hold their geometry.** A card with no image returned ""
  and collapsed to stacked text, so the template's layout was invisible until
  artwork was attached — which defeats shipping a template. A placeholder that
  preserves the cell is not decoration; it is the thing being demonstrated.
- **Adversarial review keeps paying, and the test lens is the sharpest.** The
  test agent found `headingTracking` never reached a standalone `heading`
  block, so an author's headline set looser than the cards beside it in the
  same email — invisible in every fixture because the template uses cards. The
  mobile agent independently found FOUR pre-existing parity gaps where the
  server rejected the whole document and the UI said nothing.
- **Check `mergeable_state` and the BASE's deploy health before diagnosing
  your own.** CI produced no check runs for 30 minutes because the PR was
  `dirty`; separately, main's post-deploy migration step had been failing for
  hours (a looped `.paginate()` in someone else's migration) which I flagged
  and which others fixed. Both were invisible from my branch. Add to the §6
  habit: on any confusing CI state, look at the base branch's last deploy
  before looking at your own diff.

### 2026-07-27 — Run 8 (designer feedback on campaign email → themes/templates/polls)
- Shape: 3 recon lanes → I wrote the shared contract MYSELF → 4 implementation
  agents on disjoint file sets → 4 adversarial review agents → fix → PR. The
  disjoint-file-set split worked (zero write collisions across 4 concurrent
  agents); the cost was that EVERY API signature I handed the UI agent was
  wrong, and it rewrote once the backend landed. **If two lanes share a
  contract, write the contract first and hand out the real file, not a
  described shape.** I did this for the block model and not for the Convex
  function signatures, and only the second one hurt.
- **The adversarial review was the highest-value step of the run and it is now
  §6.** Four passes over code with 3,300 passing tests found: one person able
  to vote twice after a re-send (recipient rows are wiped and re-tokenised;
  the uniqueness index keys on the dead id), a font stack able to escape the
  `style` attribute (and the far likelier mundane version — pasting the
  CONVENTIONAL `Inter,"Segoe UI",sans-serif` silently unstyles every element),
  a dark-mode fallback block that had drifted to a subset leaving poll options
  at 1.06:1, a query that could exceed Convex's transaction read limit, and a
  tally computed inside its own write transaction. None was visible to tests.
- **The "does it actually do what it claims?" lens is the one to keep.** It
  found `ensureBuiltInTemplates` shipped with NO production caller — 12 tests
  green while a real deployment's template picker would have been empty, i.e.
  exactly the feature we were asked for, absent. Then it found my *fix* for
  that had the same shape one level up: the migration's own comment claimed a
  no-op "re-runs next deploy", but `runPending` ledgers unconditionally, so on
  any freshly scaffolded deployment it would never run again. **A seeder is
  not done when its test passes; it is done when you have traced the call from
  a real production entry point.**
- **CI caught what four reviewers missed.** `/poll/` was registered in
  `apps/convex/http.ts` but absent from `infra/router`'s `CONVEX_PREFIXES`, so
  the apex domain would have served the static site — every poll link dead in
  production. The reviewer that traced the URL end-to-end confirmed builder
  and parser agreed; they did, and both were irrelevant. Encoded in §6.
- **Check `mergeable_state` early.** CI produced zero check runs for ~30
  minutes and no webhook said why: the PR was `dirty`, and GitHub does not
  schedule checks on a conflicted PR. Poll `pull_request_read`'s
  `mergeable_state` as the FIRST diagnostic when checks don't appear, not the
  last.
- **Founder steer, quoted**: "Just choose whatever color is best, we'll
  probably edit it later." Applies generally — when a decision is cheap to
  reverse and the product surface is already editable, pick and move rather
  than escalating. I'd surfaced three conflicting brand reds (`#891d1a` in her
  real newsletter, `#D23B3A` in code, `#c93431` in the Academy brand kit) as a
  decision; the right call was to unify on the one demonstrably in use and say
  so. Corollary: an inconsistency worth REPORTING is not automatically a
  decision worth BLOCKING on.
- **Don't hoard a checkpoint.** I initially refused to commit in-flight agent
  work to avoid a broken intermediate commit; the repo squash-merges, so
  intermediate state never reaches `main` and the only real risk was losing
  the work with the container. Checkpoint freely on a feature branch.

### 2026-07-27 — Run 7 (PDF receipt preview bug + personal-expense flag/Stripe repayment)
- Two founder items from screenshots. Shape: 4 parallel recon lanes → PDF
  bug dispatched IMMEDIATELY once its lane returned (didn't wait for the
  other three — that lane was self-contained and collision-free, and #440
  was merged+deployed before the feature was even scoped). Ship the small
  confirmed fix while the big one is still being designed.
- **Both founder decisions from my AskUserQuestion were later REVERSED by
  the founder** (status→flag, ACH→Stripe). See the new §3 guidance: my
  options stated mechanism, not consequence. The reversal landed mid-build
  and cost a full agent run. Corollary: when the founder picks against your
  recommendation, that's a signal to make the consequence vivid, not to
  argue — and to expect a possible reversal, so prefer the design whose
  reversal is cheapest to absorb.
- **My factual error, founder-corrected**: told them "no card rail exists"
  from a reimbursement-payout trace. `stripe.ts` had `createCheckout` all
  along. Now encoded as a §3 rule. Note the two Stripe modules are easy to
  confuse and briefs must disambiguate: `stripe.ts` = Checkout (card
  payments); `stripeFinance.ts` = Financial Connections (bank sync).
- **SendMessage redirect failed twice** → new Agent-economics rule (verify
  the redirect landed by grepping the worktree, then TaskStop+relaunch).
  Salvaged a real fix out of the discarded tree before deleting it.
- **Best design call of the run came from the implementation agent, not the
  brief**: I specified "new field, subsume `isPersonal` via migration"; it
  instead DERIVED the 3-state lifecycle from `isPersonal` + the linked
  `personalRepayments.status`, both written by one code path — no new
  persisted field, no second writer, drift structurally impossible rather
  than merely tested. Generalize: when adding a lifecycle on top of a
  boolean a money predicate already keys on, try deriving before persisting.
  Brief the CONSTRAINT (one source of truth) and let the agent pick the
  mechanism.
- **New dead-end-control class**: two near-identically-named mutations where
  one is a stub — `finances.flagPersonal` (boolean, no record, no email)
  vs `cards.flagPersonalCharge` (real workflow). The founder had been
  clicking the stub for months. Sibling of the spec'd-but-unwired class:
  when feedback says "X doesn't do anything", grep for near-duplicate
  mutation names before assuming the feature is missing.
- Webhook-settled money: flip state ONLY on webhook confirmation, never on
  the browser success-redirect, and settle through the EXISTING idempotent
  core (here `settleRepayment`, guarded on `creditTransactionId`) so
  at-least-once/out-of-order delivery is one guarantee, not a new one.
- `actions_list` token-cap parse (the invariant says "slice with python" but
  not the shape): the saved payload is a DICT — `json.loads(f)['workflow_runs']`,
  then `r['name'] | r['status'] | r.get('conclusion') | r['head_sha'][:8]`.
  `conclusion` is ABSENT (not null) on in-progress runs, so `.get` it.
- Stop-hook "commit and push" fired twice while the only dirty tree was a
  subagent's worktree holding the REJECTED design — declined both times and
  said why. Refusing that hook is correct when committing would preserve
  work already decided against; check `git status` in BOTH the main checkout
  and every worktree before answering it.
- Designated-branch mechanic worked cleanly for a second PR after the first
  merged: `git checkout -B <designated> origin/main` → cherry-pick the
  worktree branch's commits → `push --force-with-lease` (the branch held
  only already-merged history, so the force was safe).

### 2026-07-26 — Run 6 (People CRM UX: person record completeness + People→email bridge + has_service)
- Founder ask was thematic, not a bug report ("improve linking people /
  maintaining the database for volunteers, guests, donors"). Run shape: 3
  recon lanes → orchestrator spot-verified every load-bearing claim (grep
  for callers, index names, condition unions) → TWO parallel sonnet
  implementation agents on disjoint file sets — one in the main checkout on
  the run branch, one in a WORKTREE on a temp branch (`isolation:
  "worktree"`), merged cleanly after both landed. Both first-try-green on
  the full local suite; adversarial verifier found zero confirmed issues.
  Worktree isolation is the right tool for a second same-repo implementation
  agent: no interleaved commits, no tree contention, one clean merge.
- Recon mislabel to watch (now an invariant): the meta lane called five
  squash-merged source branches "in-flight collision risks." Tip dates +
  commit subjects vs the merged-PR list settled it in one git command.
- The spec'd-but-unwired class keeps paying: `setDonorPerson` (built for a
  founder complaint, zero callers), `personEmails` ledger (write-side only,
  no read query), `rsvps.by_person` guest history (indexed, never displayed).
  Grep "export const" against mobile callers early — recon found all three
  in one pass.
- Cross-feature hash check paid again (#399 class): approval snapshot
  already hashed includePersonIds AND the whole `targeting` object, so both
  new features were auto-covered — but only a code-read + a new
  CONTENT_DRIFT test proved it; the verifier confirmed post-approval
  `send()`-time recheck too.
- Stop-hook noise profile this run: repeated "commit and push" while a
  subagent had half-done edits (refused, per standing rule) and repeated
  "unverified commit" warnings on unpushed branch commits whose emails were
  already correct — that flag is the missing GPG signature, unfixable in
  sandbox and moot under squash-merge; set `git config user.email
  noreply@anthropic.com` once and move on, don't rebase mid-flight while
  agents/tests hold the tree.
- Roadmap intentionally left for future runs (say so in the PR): volunteer
  aggregation from `engagements` (+ a `volunteered_event/any` condition),
  unifying the two divergent person-merge repoint paths (dataHygiene vs
  login-time lib/people — different coverage, correctness risk), dedup UI
  consolidation, people export (no backend exists).

### 2026-07-24 — Run 5 (Reconcile: central receipt-link scope + resizable columns)
- Founder UI feedback (screenshot + prose, no attachment beyond the image):
  "central/chapter divide is confusing... can't link a receipt to a
  historical purchase... RECEIPT column too narrow... columns should be
  resizable + remember locally." 3 parallel recon lanes (scoping trace,
  column-layout trace, meta/collision survey) → orchestrator implemented
  directly (no delegated implementation agent — the orchestrator had already
  loaded full context tracing the exact fix through 6+ files across two
  recon rounds; re-deriving that in a subagent brief would have cost more
  than just writing the diff). First-try-green: full backend suite (3167
  tests) + mobile jest (252) + both typecheck targets, zero fix rounds.
- Root cause was crisper than the user's framing suggested: recon's own
  language ("it wont let me see the transactions outside the chapter") read
  like a missing feature, but the actual bug was one query/mutation pair
  (`listReceipts`/`linkReceipt`) NEVER threading the page's `centralScope`
  toggle through at all — every OTHER Reconcile query already had this
  exact scope-threading pattern (`listReconcile`'s `scope:"central"` +
  `requireFinanceCentral`/`requireCentralFinanceRole`), so the fix was
  "extend the established pattern to two functions that were missed," not
  new architecture. When a bug report describes confusing/inconsistent
  behavior on a page with several near-identical queries, check whether one
  of them just didn't get the same treatment as its siblings — cheaper than
  assuming a novel design gap.
- SECURITY IMPROVEMENT ON THE ESTABLISHED PATTERN: rather than mirroring
  `listReconcile`'s client-supplied `scope`/`chapterId` args for the WRITE
  mutations (`linkReceipt`/`unlinkReceipt`), derived scope from the TARGET
  TRANSACTION's own `chapterId` server-side instead (`attachReceipt` already
  did exactly this for uploads — proved the pattern safe and correct before
  reusing it). Client-supplied scope is right for a BROWSE/search query (no
  target doc exists yet to derive from); doc-derived scope is strictly
  better for a WRITE against a known target (smaller args surface, can't be
  spoofed). Don't copy the read-path pattern onto a write path without
  checking whether the write already has a better anchor available.
- CAUGHT IN SELF-REVIEW, not by a subagent or CI: a raw `<div onMouseDown>`
  web resize handle (mirroring `SiteMapEditor`'s own proven raw-DOM drag
  pattern) rendered unconditionally whenever a `startResize` callback was
  passed — but the callback itself no-ops on native via an internal
  `Platform.OS` check, while the JSX around it had no such gate. `<div>` is
  not a valid React Native host component; this would have been a genuine
  release-blocking native crash that TYPECHECKS FINE and every test suite
  passes clean (no test renders the native app tree). Lesson: when adding a
  web-only raw-DOM affordance to a component that ALSO renders on native
  (no `.web.tsx` split), the `Platform.OS==="web"` gate belongs on the JSX
  branch itself, not just inside the handler function — re-read every
  "web-only" diff asking "does this JSX ever mount on native," since neither
  tsc nor RN's own test suites catch a native-only runtime crash.
- Environment note: `pnpm install` + full typecheck + full vitest/jest
  suites all worked in this sandbox this run (consistent with Run 2
  addendum 5's "401 constraint lifted"). Standing up a LIVE Convex dev
  deployment did not (`npx convex dev` → "Failed to fetch latest backend
  version" — no network path to bootstrap a cloud dev deployment, no
  `.env.local` credentials present). So: local static verification
  (typecheck, unit/integration tests against convex-test) is reliable here;
  a real running app with auth + seeded data is not, and manual/visual
  browser verification for a UI change should be reported as "not possible
  in this sandbox" rather than skipped silently or faked. Budget CI (which
  runs in a real environment) as the actual visual/integration gate for web
  UI changes when the sandbox can't launch a live deployment.
- Academy: judged NOT training-worthy and said so explicitly in the PR
  body — this PR fixes existing-but-broken behavior (the Central toggle
  isn't newly introduced) and adds a generic UI mechanic (drag-resize
  columns), neither of which is a domain/process concept the Academy
  teaches. Named but deliberately left OUT OF SCOPE: the Reconcile lesson
  doesn't teach the Central/My-chapter toggle AT ALL today (confirmed by
  recon) — a real pre-existing Academy gap, but a separate, larger
  authoring task from this bug-fix PR.

### 2026-07-24 — Run 3 addendum (prod hotfix: wasm loading)
- "Local + CI green" was NOT prod green: the founder's screenshot proved
  scanned PDFs still dead-ended. Prod probing via the Run Convex Function
  workflow (workflow_dispatch → `npx convex run` with the admin deploy key)
  found the exact errors: Convex's deploy does NOT ship a package's `.wasm`
  asset next to bundled JS (default pdfium build → ENOENT), and
  `externalPackages` didn't preserve the layout either; the `browser/base64`
  fallback is web-compiled and throws "not compiled for this environment" on
  prod's real Node. The two-tier fallback passed vitest edge-runtime and
  failed prod — different environments failed OPPOSITE tiers. Fix: import
  the base64 wasm constant (plain JS, bundles anywhere) and pass
  `wasmBinary` to `init()` explicitly; pin the dep EXACTLY (hashed chunk
  filename). Research-agent claim "pdfium embeds its wasm in the JS" was
  wrong — verify asset-loading claims empirically before shipping.
- Prod-probe recipe that works: `increase:listChapterIdsForBackfill` (no
  args) → `receipts:findNextFailedReceipt {chapterId}` →
  `receipts:runRetryExtraction {receiptId}` → `receipts:getReceiptForProcessing`
  read-back. `convex run` streams ONLY the direct function's log lines, not
  nested ctx.runAction logs — probe the inner action directly to see its
  logs. `_system/cli/*` UDFs are NOT runnable via `convex run`.
- After any deploy that changes an action's behavior, re-probe the REAL
  failing artifact in prod before telling the user it's fixed.
- Root cause landed one layer deeper than each hypothesis: not the wasm
  asset (fixed, still died), not V8 compile, not emscripten init (staged
  probe cleared both in <1s), but BITMAP SIZE — scale-2 rendering a tall
  phone-scan page = ~48MB RGBA per page × 3 pages OOM-killed the 512MB
  worker (uncatchable, log-less). Fixture-size blindness: local tests used
  300×144pt PDFs; prod scans are 1179×2556pt. Cap OUTPUT DIMENSIONS (2000px
  longest side), never use a fixed scale on user-supplied page sizes — and
  test with production-shaped inputs, not toy fixtures.
