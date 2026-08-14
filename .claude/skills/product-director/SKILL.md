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
   - **Cross-lane seams — MANDATORY whenever two lanes ran in parallel.** Each
     lane is correct alone; the defect lives between them and NO lane can see
     it. Two shapes, both caught live: (a) lane A RELOCATES information into a
     channel (a `notes[]` log, a badge, a toast) that lane B is simultaneously
     restyling, capping, or collapsing — A's justification ("the info is still
     shown") is then false as shipped; (b) lane A edits a doc/lesson for
     VOCABULARY while lane B changes the BEHAVIOUR that same sentence
     describes, so the rename lands on a now-false claim. Ask of every lane:
     what did it assume about a file it did not own, and who owned that file?
   - **A new "refuse" path — trace what the CALLER does with the refusal.** A
     guard that refuses rather than guesses is right, but it is only as good
     as its caller's handling. Run 20: a one-time migration correctly refused
     when it could not prove full scan coverage, but `migrations.ts#runPending`
     ledgers on any normal return — so the refusal would have been recorded as
     APPLIED, skipped forever, and the cleanup silently never happened while
     the deploy reported success. Refusals reached through an automatic runner
     must THROW so nothing is ledgered and the step goes red.
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
- **In a SHARED checkout, always `git commit -- <paths>`, never a bare
  `git commit`.** `git add <paths>` does not isolate you: the index is shared,
  so a bare commit writes whatever a sibling agent happened to stage. Put this
  in every implementation brief, and check `git diff --cached --name-only`
  before committing.
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
- **AGENT LIVENESS — the `output_file` is a SYMLINK. Always `stat -L`.**
  `stat -c%s <output_file>` returns the length of the LINK TARGET PATH (~110
  bytes) for EVERY agent — alive, dead, or long finished. Run 17's
  "120-byte file = dead agent" rule is therefore wrong and will fire on a
  perfectly healthy fan-out (it did, Run 20, on two agents writing 300KB+).
  The correct check, cheap enough to run every tick:
      stat -Lc%s <output_file>   # real transcript size, grows while alive
      stat -Lc%y <output_file>   # last write; >~10 min idle = dead
  Pair it with `git log`/`git status` in the agent's checkout or worktree —
  a live transcript with zero commits past ~30 min is a STUCK agent (Run 15),
  which is a different failure needing a concrete nudge, not a relaunch.
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
4. **AI assist earns trust before it scales — and this one didn't.** The
   founder REMOVED AI category suggestions from coding entirely (2026-08-12:
   "I did take that out… it was just bad"), and the removal is now doctrine,
   not a pause: coding is a human writing what the money was for, subject to
   a minimum length and a second person's review. Do not propose
   re-introducing suggestions here without being asked. The general rule
   still stands elsewhere: no "accept all" until precision is measured and
   high, accepted suggestions must visibly clear, and "most of it is wrong"
   means quality work first, affordance second.
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
9. **A control must never report enforcement it cannot deliver.** If a
   status says "locked", "approved", "sent", "verified", trace it to the
   thing that ACTS on it and prove that thing is reachable for the row in
   question. A control that is a no-op for some subset is worse than an
   absent one: the absent one gets noticed. When a mechanism only covers
   part of a population (one issuer, one provider, one card source), the
   product must say which part, and the lesson teaching it must say so too.
   Found live 2026-08-12: the 7-day card auto-lock patched every `cards`
   row, but enforcement runs through Increase's real-time authorization
   webhook, which only ever asks about cards Increase issued — so linked
   Relay cards were marked locked and kept working, and both founders had
   concluded the whole ladder was decorative.

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
- **Never read a SKIPPED check as a passing check** — absence of evidence.
  Confirm against the last merged PR whether a skip is standing workflow
  config, and run the tool locally anyway.
- **On any confusing CI state, look at the BASE branch before your own diff:**
  check `mergeable_state` first (GitHub schedules no checks on a `dirty` PR,
  so "no check runs for 30 minutes" is usually a conflict, not a CI outage),
  then main's last post-deploy run — someone else's broken migration on main
  is invisible from your branch and will read as your failure.
- Two easily-confused Stripe modules: `stripe.ts` = Checkout (card payments);
  `stripeFinance.ts` = Financial Connections (bank sync). Briefs must say which.
- **A one-time production DATA operation belongs in a MIGRATION, not a
  hand-run mutation.** `.github/workflows/deploy-convex.yml` runs `npx convex
  run migrations:runPending` post-deploy, so a registered migration executes
  automatically with admin rights — no signed-in identity, no dashboard, no
  human with prod credentials. A guarded mutation needs an access PATH the
  intended persona may not have (a nonprofit ED/FM authenticates through the
  app, not the Convex dashboard), and it is not in `_generated/api.d.ts` until
  a `convex dev` cycle regenerates it. Ship the migration as the executor and
  keep any mutation as the dry-run/inspection twin, with ONE shared guarded
  core so the two can never disagree about what is safe. `runPending` ledgers
  on normal return and skips forever after — so an automatic migration must
  THROW on refusal (see §6's refuse-path lens) and its tests must prove no
  ledger row is written when it does.
- Adding a SEAT CAPABILITY is a six-step change, and steps 4-6 are the ones
  that get missed: (1) string in `SEAT_CAPABILITIES`; (2) on the seats;
  (3) `EXPECTED_CAPABILITIES_BY_SEAT` (seats.test.ts); (4) a MIGRATION —
  capabilities are read from the `seatDefs` TABLE, so code alone is dead on
  every already-seeded deployment (copy `0053_add_campaign_design_defaults.ts`);
  (5) sweep `toEqual` capability fixtures REPO-WIDE (`campaignPower`,
  `givingPower`, `0025_*` all pin arrays, not just the seats spec); (6) prove
  the Academy lesson is REACHABLE from the granting seats' `ROLE_PATHS` by
  resolving them in a script — authoring it into a plausible-looking course
  reached one of six holders.
- Any "export/report over existing data" feature needs its OWN paginated read
  path: every list query here is capped for its grid (donors 500, gifts 250,
  reconcile 5000), so building on them silently truncates. Size pages by
  COST PER ROW, not row count — a wide row with six per-row joins blows
  Convex's ~16k-read transaction limit at a 500-row page on real data while a
  three-row seeded test passes.
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

### 2026-08-14 — Run 21 (repayment receipt email + the manual "Send receipt" button)
- **A builder declined an affordance for a correct reason and still got it wrong,
  and the founder had to ask for it.** The receipt builder wrote: "no manual
  resend — matches the 'there is no manual mark repaid' posture; every
  settlement is a real payment, so nothing needs a manual trigger." True of the
  SYSTEM, irrelevant to the HUMAN: people lose emails, and a backlog of
  repayments settled before the feature existed had no receipt at all. New
  question for every brief that omits a manual control: *the system may not
  need this, but does a PERSON?* Absence of a machine trigger is not absence of
  a human one.
- **Stamp-before-send is right, and incomplete on its own.** Copying #727's
  at-most-once claim gave duplicate-safety and, unexamined, silent permanent
  LOSS: a payer with no email hit a bare `continue` with zero logging, a Resend
  failure logged without recipient or row id, and nothing could ever retry.
  Precedent transplants carry the precedent's tradeoffs — re-ask whether they
  still hold. An approval FYI can afford a silent loss; EVIDENCE a person may
  need to prove they paid cannot. The shape that worked: keep the claim, split
  "claimed" from "delivered", record and log every failure path, ship a
  backfill.
- **A claim stamp is not a lock.** The claim commits, then the action does
  network I/O OUTSIDE that transaction — so two claimers (manual vs backfill,
  manual vs automatic) both sent, proven by probe: two emails, one payment,
  nobody asked. Convex's mutation serializability protects the claim, not the
  send. Any "claim then go do I/O" shape needs an explicit in-flight marker
  checked by every claimer, cleared on BOTH outcome branches (a failure that
  leaves the lock set wedges the row), with a staleness escape for a dead
  process. Second cousin of Run 20's refuse-path lens; both now §6 items.
- **Bank-feed strings render into HTML and the escaping held — but the
  EXTERNAL-API string did not.** Merchant names (hostile payloads, quotes,
  `</td>` breakouts) were all escaped. The Stripe `receipt_url` was not: gated
  only on `startsWith("https://")`, which says nothing about an embedded quote,
  and a probe rendered a live `<script>`. Generalize: when a file documents
  "raw interpolation is safe because every call site builds this from X",
  the FIRST call site to source that value from anywhere but X is the bug —
  grep the invariant's justification, not just the sink.
- **My own brief carried a stale number and the agent caught it.** I asserted a
  ~373-error mobile tsc baseline; the real figure was 409. The agent proved
  zero-new by diffing the error list byte-for-byte against the pre-change tree
  rather than trusting my number. Keep writing "count the baseline YOURSELF and
  prove zero new" into briefs — it survives an orchestrator being wrong.
- **`actions_list` is a context hazard and its `branch` param does not help** —
  passing `branch` still returned main's runs and burned ~15k tokens. The only
  reliable shape is: call it, let it save to file, then
  `python3 -c "json.load(...)"` filtering on `head_sha`. Never read the raw
  result.
- **The Academy changelog block conflicted on THREE separate merges in one
  day** (once on the reconciliation PR, twice on this one), always the same
  doc-comment, always resolvable by keeping both entries. It is a serialization
  point for every concurrent finance PR. Recommend to the founder that it move
  out of the source file; until then, expect it and resolve by appending, never
  choosing.
- **Founder asks this run, quoted:** "when people pay what they owe… hey,
  thanks for paying this off. This is your receipt… just in case they need a
  receipt for showing that they did the payment"; and "add an email button for
  already paid repayments… say they forgot it, or they just need it resent, or
  it's in the past." The second is the standing lesson above: ship the human
  override alongside the automatic path, not after being asked.

### 2026-08-14 — Run 20 (morning reconciliation: ledger clutter, transfer history, "flag" reads as scary)
- **I ASSERTED A LIVE BUG FROM SCAR TISSUE AND HAD TO CORRECT MYSELF TO THE
  FOUNDER.** I found `reverseExcludedSettlementLoop.ts` (a one-time cleanup
  for a settlement feedback loop), matched its numbers to her screenshot, and
  told her the loop was live and "worse than clutter" — before reading
  `lib/bookBalance.ts`, the ONE file that decides the question. Line 68 zeroes
  `balance_settlement` out of book value precisely so "the target would chase
  itself" — the loop was fixed months ago. The real defect was duller and
  exactly what she'd said: a $0 row that never closes the gap it measures, so
  it re-books identically every morning forever. **A remediation script in the
  tree is evidence a bug ONCE existed, never that it exists now.** Read the
  authority file before characterizing severity; correcting upward ("worse
  than you thought") costs more credibility than starting accurate.
- **The cross-lane gap is real, and only the orchestrator can see it — now a
  mandatory §6 lens.** Backend lane removed the ledger rows and moved the
  finding into the run-summary `notes[]`, justified as "the UI already renders
  notes." The UI lane, in a different file, simultaneously capped notes at 6
  and collapsed past 3. Net: on any ordinary morning the advisory was hidden
  behind a closed-by-default toggle, and past six notes it was DISCARDED —
  and balance-settlement notes are pushed at step 8, LAST, so they were first
  against the wall. A reviewer proved it with a slice-logic probe. Both lanes
  were individually correct; the justification for the whole change was false
  as shipped. Fix shape that worked: a TYPED field on the run payload, not a
  string in a log, rendered unconditionally NEXT TO the toggle that causes the
  condition — effect beside cause, which also makes the "Turn on" button
  self-explanatory.
- **A safety guard can be self-defeating through a different entry point.**
  The migration lane independently added refuse-on-truncation, which fixed a
  bug the security reviewer had separately proved (`.take(5000)` with no
  `.order("desc")` reads the OLDEST rows, so a recent pair was invisible with
  `problems: []`). Two lanes converging on one defect from opposite directions
  is a good sign — but neither could see that `runPending` ledgers on normal
  return, so a refusal would be recorded as APPLIED and skipped forever. Now
  §6 lens + an invariant. Generalize: adding a refuse path is half the work;
  the other half is what the caller does with it.
- **`stat -c%s` on an agent's `output_file` is meaningless — it's a symlink.**
  Every agent reads ~110 bytes, alive or dead. Run 17's "120 bytes = dead"
  rule fired a false alarm on two agents that were writing 300KB+. Corrected
  in place; use `stat -Lc%s` / `stat -Lc%y`.
- **The dead-branch false positive struck a THIRD time**, from a haiku survey
  that flagged `chore/reconcile-drop-ai-and-transfers` as an active collision
  across all five hot files. Tip was 6 days old and every commit subject
  matched an already-merged PR (#556-#559); "no merge base" was just the
  shallow clone. Cost ~2 minutes to disprove because I checked rather than
  believed. Keep checking — but consider telling survey lanes to apply the
  tip-date-vs-merged-subjects test THEMSELVES rather than reporting raw.
- **Refusing the stop hook was correct ~5 times and should be stated plainly
  each time.** "Commit these changes" fired repeatedly while the only dirty
  file was a component an agent held open mid-edit; committing would have
  landed a typed field with no UI rendering it — the very bug being fixed.
  Name the specific file, name the agent holding it, note its last-write
  timestamp, decline. Push freely once a lane's tree is clean; a feature
  branch with no PR yet costs nothing to push and satisfies the hook honestly.
- **Founder decisions this run, quoted, now standing:** on the never-executed
  `balance_settlement` backlog — **"delete them outright"** (chosen over
  leave-them and mark-excluded, with the no-audit-trail cost stated); and
  **"cant you run a migration to delete the rows"** — she was right and my
  framing had been wrong, which produced the new migrations invariant above.
  Her instinct that a machine-written row with no economic meaning "is just
  wrong and cluttered" was correct on the merits: `signedBookCents` had been
  returning 0 for those rows all along, i.e. the code already agreed with her.
- **Vocabulary:** "Flag" on a money row reads as destructive even when the
  action is a benign annotation. The repo already had the fix — `Button`
  `variant="muted"`, added after a prior round where "every row looked
  alarmed." Renamed to "Mark for review" throughout the presentation layer
  with the Convex mutation names untouched. When a control's name is a
  punitive VERB, prefer naming the STATE it produces.

### 2026-08-13 — Run 19 (finance IA: "what's the difference between reconcile and coding even?")
- **An IA complaint is a request for a DIAGNOSIS, not a redesign — and the
  run shape is inline recon, no fan-out.** The founder asked "you tell me if
  I'm missing something." Answering that needed ~8 targeted reads (the
  layout, the four screens' module docs, the shared filter constants) and
  zero subagents; dispatching build lanes off an unvalidated design would
  have been the expensive mistake. Deliverable was one assessment artifact
  ending in four named decisions, each with a recommendation. When the ask
  is "explore what this looks like," ship the argument, not a branch.
- **This repo's module doc comments ARE the recon lane.** Every finance
  screen opens with a doc block stating who it's for and why it exists
  separately — `explain.tsx` literally documents that it exists because two
  OTHER surfaces' facets exclude the rows it needs. Read the doc blocks
  before tracing queries; they hand you the design history for free and they
  are consistently honest about their own workarounds.
- **The diagnosis that generalizes: a surface split by FIELD GROUP reads to
  users as an arbitrary split.** Reconcile owns the bookkeeping columns,
  Coding owns the substantiation columns, on the same row. Different
  reviewers and different permissions are real and still don't justify
  separate screens — they justify a column and a gate. The tell was that
  Reconcile's row action already opened the full coding surface
  (`ReconcileList.tsx` comment icon → `TransactionDocumentationModal`) and
  its filter bar already shipped `uncoded`/`coding_review`. **Before
  proposing a merge, grep whether one surface already embeds the other; if
  it does, the merge is mostly deletion and you can say so with numbers.**
- **Grouping nav chips DEFERS an IA problem and the founder will return.**
  The 2026-08-11 directive ("this is just way too much") was answered by
  hiding four chips under two group chips. Two days later: "one of the tabs
  has three subtypes under it — that's unacceptable." Consolidating
  navigation without consolidating SCREENS moves destinations down a row.
  When a founder says a bar is too big, count destinations, not chips.
- **The one thing that can't merge is usually a permission boundary, not a
  workflow.** `finances.personTransactions` is caller-scoped and needs NO
  finance grant; every sibling query throws for that persona. That single
  fact is what makes "two surfaces" the right answer rather than one, and it
  is the same fact that makes the founder's requested `/code` page a real
  route rather than a deep link. Look for the seat-free query when deciding
  how many surfaces a domain needs.
- **Founder verbatim, now standing:** the finance area must serve three
  audiences explicitly — the financial manager reviewing, the executive
  director backfilling history, and the spender coding their own charges;
  "I'm fine with this being two tabs, but I'm not fine with two tabs and one
  of them having three subtypes"; and there must be a page "I can send
  people to, like /code" where someone sees their own transactions, uploads
  receipts and states reasons. Nesting in the finance bar is now a defect
  class, not a layout preference.

### 2026-08-13 — Run 18 (the auto-coding roadmap: reimbursement port, backlog split, refund auto-pair, heuristic visibility)
- **Three parallel worktree builds + orchestrator-built fourth, all landed
  sequentially in one night — the collision that mattered came from OUTSIDE
  the run.** A sibling session merged migration 0067 to main mid-build,
  colliding with the port brief's "create 0067". Caught on a routine branch
  sync (the migrations/index.ts import list showed a number I never wrote);
  one SendMessage renumbered the agent to 0068 before it finished, and the
  landing conflict was the trivial append-merge predicted. Rule: when a
  brief assigns a migration NUMBER, re-verify the number against origin/main
  at every sync, not just at brief time — and tell the agent what the merge
  will look like so it keeps its changes append-only.
- **"Anchor loosened" is the review lens that pays: both feature agents
  independently loosened a required-field anchor** (codedByUserId for
  accountless claimants; actorUserId for machine audit rows). Both calls
  were RIGHT on the merits and both were flagged honestly — but one shipped
  the constraint as a comment, and the probe proved any human call site
  could write an anonymous audit row. The durable rule: an exception to an
  integrity anchor must be ENFORCED at the single write path (allow-list +
  negative tests), never documented-as-convention; and every anchor
  loosening gets its own review lens item with a "can this defeat a guard"
  probe (SoD held because comparisons were personId-based — proven, not
  assumed).
- **Two agents cross-verifying the same full-suite flake beats one.** Both
  builders hit the same 6 unrelated timeouts in their full-repo sweeps;
  each independently re-ran the offenders (one on a pristine base worktree,
  one in isolation) and converged on load-contention-under-parallel-suites.
  Concurrent worktree builds make the full sweep unreliable as a gate —
  scope agent gates to named suites, keep the full sweep as advisory.
- **Founder decision, quoted, now standing:** on the Opus roadmap — "let's
  go with your best recommendation on all of this" — which cashed out as:
  reimbursement request approval IS the coding review (single-line complete
  requests materialize approved codings, ported verbatim, provenance
  stamped); reconstructed history splits the meter rather than
  auto-explaining; refund auto-pairing keys on the provider's structural
  link only; the payout text-heuristic keeps zero-touch but must say on the
  row how it claimed it.

### 2026-08-13 — Run 17 (Explain-worklist noise: fees/personal/transfers; names bulk entry; recurring-charge suggestions)
- **THE RECON FAN-OUT DIED SILENTLY AND COST TWO HOURS — the founder caught
  it, not the ticker.** Three of four recon agents died at launch (output
  files stuck at 120 bytes, the harness init line); the fourth completed
  normally, which masked the pattern. The armed Monitor ticker fired once at
  +4min (agents looked alive — timestamps 4min old), then hit its ~30min
  timeout and I never re-armed it, so nothing checked again until the founder
  asked "you seem stuck?". TWO rules hardened: (a) check agent liveness on
  every tick — see the CORRECTED mechanic in Run 20 below; the raw-size rule
  originally written here was WRONG and produced a false dead-agent alarm.
  (b) The ticker
  timeout notification is itself a poll tick: re-arm AND run the full check
  cycle in the same breath, never just re-arm. Recovery that worked: do the
  recon inline yourself (the orchestrator knew most of the ground), keep only
  the build lanes delegated.
- **The date-rollover CI flake struck AGAIN one day later, one fixture over**
  (cards.test.ts "a charge that already has a receipt": ageDays 5 crossed the
  2026-08-08 coding epoch on 08-13, and the chase is coding-keyed now, so a
  receipted-uncoded charge legitimately escalates). Run 15's lesson said grep
  for the class; the durable fix is different: when a fixture's CLAIM is
  "owes nothing", stamp EVERY obligation satisfied (receipt AND codingState)
  rather than leaning on the fixture predating an epoch — each unsatisfied
  axis is a scheduled future failure. Verify "not mine" by reading the sweep
  predicate, not by rerunning on main (a worktree with symlinked node_modules
  does not run vitest reliably under pnpm).
- **"Only things that actually need explaining" is a PREDICATE-UNIFICATION
  ask, not a filter ask.** The founder's fee/personal/transfer complaint
  resolved into one shared classification (`autoExplainedKind` in shared)
  consumed by the worklist, its otherBooks twin, AND the snapshot's
  unexplained counts — plus carve-outs in requiresCoding/needsDocumentation/
  isUndocumented (and the INLINE requiresCoding mirror in
  transactionCodings.ts — grep for mirrors when touching a predicate; this
  repo duplicates them deliberately). The founder also supplied the public
  wording verbatim ("accidental personal charge, paid back / awaiting
  repayment") — derived from the linked repayment's real status so the page
  can never claim repayment before the money arrived. Machine-derived STATUS
  LINES are compatible with the no-AI-in-coding doctrine: the ban is on
  composing a human's testimony, not on the product describing its own
  records.
- **Founder decisions this run, quoted, now standing:** "only things that
  actually need explaining should show up [in Explain], so I can attack this
  month by month"; personal charges on the public ledger read "accidental
  personal charge, paid back (if paid), and awaiting repayment (if we are
  waiting)"; recurring same-vendor charges should "auto suggest the coding"
  (shipped as prior-approved-coding surfaced with provenance + explicit tap —
  the reimbursement-prefill carve-out's shape, NOT silent prefill, because a
  different charge's coding is an analogy, not this charge's testimony);
  names bulk entry: paste lists, row delete, roster autofill, "start with
  the team".
- **Run 17 follow-ups (same day, live founder loop):** (a) "Start with the
  team" shipped broken — the fill-blank-rows branch mapped over the raw
  (empty) attendees STATE while the notice separately claimed success; the
  builder's tests never rendered the hook, exactly the gap its reviewer had
  flagged as "traced, not executed". Durable fix shape: extract bulk state
  ops into PURE merge functions and pin the founder's exact scenario; a
  one-shot notice must never narrate state — derive banners from live state
  so screen and message can't disagree. The founder's model was PRUNE-DOWN
  ("populate ALL the team members, then ✕ people") — a threshold is where a
  requirement stops, not where an editor stops. (b) The auto-explained class
  keeps growing on founder asks: cashback ("just money back — auto code
  these ones as well"; the provider's own source.category was received and
  DROPPED at ingestion — store provider classifications verbatim, they're
  free positive markers) and full-refund pairs ("if something's refunded,
  why are we coding it?"). When adding a kind to a shared classification,
  grep every consumer for a hardcoded per-kind branch — the snapshot's
  else-branch had frozen "fee" in and the new kind arrived wearing the
  wrong sentence. (c) Founder directive: "we should really only need a
  human when it comes to these coding tasks" — an Opus analysis lane now
  owns the "what else auto-codes" question.

### 2026-08-12 — Run 16 (founder call transcript: reconcile totals, spending policy, card-lock reality, money model)
- **The headline finding came from disbelieving the founders, not the code.**
  Both of them stated on the call that the 7-day card lock "doesn't actually
  happen… it just made a bunch of rules that it actually doesn't enforce."
  The ladder turned out to be entirely real — cron-wired, and enforced in
  real time by `decideCardAuthorization` off Increase's webhook. But tracing
  it to prove them wrong is what surfaced the actual defect: the sweep scans
  `ctx.db.query("cards")` with no `source` filter, and enforcement can only
  reach rows Increase issued, so `source:"legacy"` Relay cards were being
  stamped `"locked"` while continuing to work. **Both halves of the founders'
  belief were wrong in opposite directions, and only reading the enforcement
  path found it.** Generalized into standing principle #9. When a user says a
  rule "doesn't fire", the answer is never just yes or no — ask *for which
  rows*.
- **Ask "what ACTS on this status?" for every status the product displays.**
  The whole finding reduces to one question `lockCard` couldn't answer:
  patching `status:"locked"` is not locking anything; something has to
  consult that field at authorization time. Same shape as Run 8's
  "`ensureBuiltInTemplates` has no production caller" and Run 10's "reachable
  only from a screen that throws" — third occurrence of the class, now
  promoted out of the log into the principles.
- **A pinned cap you didn't know about is cheaper to hit than to guess at.**
  `apps/convex/tests/academy.test.ts` enforces a hard 3–5 quiz-question range;
  I wrote 6- and 8-question quizzes, and the suite caught all three. The
  repo's own convention (stated in the snapshot test's header) is that a
  lesson at the cap SWAPS questions rather than grows — which forced a genuinely
  better edit: dropping "why does the app lock instead of reminding forever"
  (motivation, not a rule) and the past-due-pledge edge case (taught properly
  in the Development stream) to make room for the material the founder
  actually asked for. Read the pinned-constants tests BEFORE authoring
  Academy content, not after.
- **A "filter the noisy list" ask can be a display regression in disguise.**
  Founder wanted $0 budgets out of the "For" picker. The obvious edit —
  filtering `isAttributableBudget` or `forPickerOptions` — would have broken
  label RESOLUTION, because `ForPickerCell` derives a row's current "For"
  label from that same payload: any charge already attributed to a $0 budget
  would silently render "None". Correct seam was `rankForPicker` (the per-row
  OFFER list) plus an explicit carve-out for the transaction's current
  budgetId. **When filtering a list, check whether anything reads it as a
  lookup table.** Also: the pre-existing `forPickerScanParity` suite asserts
  both surfaces return identical candidate sets; my change made that
  legitimately false, and it passed only because the fixture had no $0 budget
  — so I added the divergence as an explicit test rather than leave the
  invariant accidentally true.
- **Totals over a paged list belong on the server, over the match set.**
  `listReconcile` already computed `matchedCount` across the whole scope
  before paging; `selectionTotals` rides the same `selected` array. A
  client-side sum of loaded rows would have changed after every "Load more".
  Reused `signedBookCents` rather than writing a second summation, which
  bought agreement with the book-value model for free — and surfaced that a
  selection of transfers/excluded rows legitimately totals $0, hence the
  `neutralCount` field so the UI can explain it instead of looking broken.
- **Founder decisions this run, quoted, now standing:** spending policy is
  green/yellow/red with a three-question pre-check ("know what budget you're
  going to be spending out of… and know that there is enough money in that
  budget for it… get approval if it's yellow track. Never red"); it is
  DELIBERATELY not a product feature ("there's not really a way you can
  enforce it… it'll just be training"); each event/project has one budget
  owner and spending within an approved budget is a heads-up, not a fresh
  approval ("less about getting a formal approval and more so saying, hey,
  I'm about to buy this thing, can I put it on your event budget?"); AI
  category suggestions are removed for good, not paused ("it was just bad");
  Stripe fees stay one monthly line item, not per-transaction.

### 2026-08-12 — Run 15 continuation (the "Restricted" that wasn't, and the validator that lied all night)
- **A screen that renders one fallback for every failure will send you
  chasing the wrong bug for a night.** The founder's "Restricted" publish
  console survived a real gate fix (#655), a boundary-latch fix (#657), and
  a hard refresh — because the actual failure was `preview` failing its OWN
  returns validator on every call (fields added to the snapshot in #642,
  never to the second validator in the same file), and FinanceBoundary
  rendered the same denial copy for a crash as for a denial. TWO standing
  rules out of this: (a) an error fallback must print what it caught — a
  ConvexError gets denial copy + the server's message, anything else gets
  crash copy; ship that DIAGNOSTIC first when a symptom survives its fix,
  because it converts the user's next screenshot into the root cause. (b)
  When one file defines a type and TWO validators over it, adding a field
  is a three-site change — grep for sibling validators (`v.object`) over
  the same spread source before calling a field addition done.
- **"The suite is green" says nothing about a query nobody calls.** 60+
  publicLedger tests coexisted with a console that could not open, because
  no test ever simply CALLED `preview`. For every client-facing query a
  screen mounts on load, there must exist at least one test that calls it
  and asserts non-null — shallow on purpose; its job is validator drift.
- **Contradiction analysis beats symptom-matching for access reports.** The
  decisive observation was the founder's own screenshot: the Accounts tab
  (gated by `isCentralEdOrFm`) rendering in the SAME frame as a "you lack a
  seat" denial for a gate that now passes `isCentralEdOrFm` first. When a
  user reports a denial, first find a visible surface gated by the same
  resolver — agreement between the two falsifies the denial theory in one
  look, no server access needed.
- **90 minutes of active-but-writing-nothing is a stuck agent; one concrete
  nudge un-sticks it.** The workbench builder explored for ~87 min with a
  clean tree; a SendMessage with a numbered commit-by-commit plan ("stop
  exploring; ship in this order, commit each") produced the first commit in
  ~5 min and a finished feature in ~40. Liveness timestamps alone are not
  progress — check `git log` in the worktree on every tick, and nudge at
  the first tick past ~30 min with zero commits.
- **The founder's UX directives are standing, not per-surface.** "No
  blocking modal" shipped on By-month; the founder immediately hit the
  modal on the Code tab and reported it as a bug. When a directive names an
  interaction pattern, sweep every surface with that pattern and either
  convert it or state why not in the PR — a persona-based exception
  (cardholders can't fetch receipts) is an implementation constraint to
  design around (capability probe + degraded pane), not a reason to keep
  the old interaction.

### 2026-08-12 — Run 15 (founder voice-note: coding/reconcile confusion, ED lockout, false "fully explained", publish preview, self-approve)
- **A fixed-date policy epoch plus relative-date fixtures is a scheduled CI
  outage.** `DEFAULT_CODING_REQUIRED_SINCE_MS` (2026-08-08) armed while
  `cards.test.ts` seeded a charge at `Date.now()-4d`: green through 08-11,
  red everywhere on 08-12, blocking every PR that day. THREE separate
  subagents independently verified it "pre-existing" (correctly) — but the
  orchestrator had to recognize it as a TODAY-blocking base failure, not
  background noise, and fix it first. When a suite goes red on a date
  rollover, grep the repo for `Date.UTC(` policy constants vs `Date.now() -`
  fixtures near the failure before diagnosing anything else.
- **The access-ladder review lens caught the exact failure it was written
  for, one layer up from where I looked.** WS-A widened the server gates for
  the ED and its review proved the widening UNREACHABLE: `financeRoles.
  mySeats` returns `[]` for every ED (the specializedRoles bridge fires only
  for `roleKind === "finance"`), so `_layout.tsx` routes EDs to member tabs
  and no navigation reaches the widened surfaces. "Does the client access
  query distinguish the new rung" (Run 10's rule) generalizes to: *can the
  persona NAVIGATE to the gate at all?* Tab-set gating is part of the ladder.
- **A mid-run founder voice note is a fork, not a queue item.** "Coding UX
  must be side-panel, receipts big, pinch-zoom, no blocking modal" arrived
  while WS-B was restyling the modal. Right call made: the small isolated ask
  (superuser self-approve) was built by the orchestrator in the main checkout
  the same hour (worktrees keep it collision-free), the big UI reframe became
  a QUEUED workstream behind the in-flight one touching the same files —
  redirecting a mid-build agent toward a bigger design it wasn't briefed for
  is how half-designs ship.
- **Resuming a COMPLETED agent with SendMessage works well for fix rounds**
  (three did fixes in their own worktrees with full context, no re-brief) —
  the Run-7 "SendMessage is unreliable" caveat applies to agents mid-run,
  not to completed ones being continued.
- **Fixture-shape guardrails from this repo, verified the hard way:**
  a brief that says "pre-existing mobile tsc failures are only in campaign
  designer files" will be wrong — agents found `registrationDisplay.test.ts`
  and ~324 baseline errors; the durable phrasing is "assert your touched
  files add zero NEW errors against the counted baseline". And worktree
  agents start with NO node_modules — tell them `pnpm install
  --frozen-lockfile` is expected, not a surprise.
- **Founder decisions this run, quoted, now standing:** "as super admin, I
  need the ability to just approve my own coding things" (recorded
  `approvalParty: "single"`, mirroring budgets); coding review UX = "click
  in and click out… see the receipt, like really big… not a modal in the
  middle of the screen that blocks your ability to see other things"
  (side-panel workbench spec, queued); Reconcile-vs-Coding confusion is
  primarily DISCOVERABILITY (the reconcile row's comment icon already hosts
  the full coding surface — surface it, don't rebuild it).

### 2026-07-31 — Run 14 (data export: people/giving/tasks → one wide CSV per dataset)
- **The ONE question I asked reversed my own recommendation, and asking cost
  two minutes.** I proposed a relational bundle of joined CSVs (recommended)
  vs. one wide spreadsheet; the founder picked the wide spreadsheet ONLY. That
  deleted a hand-rolled ZIP writer, a manifest, and a join README from the
  plan before anyone wrote them. Generalize: when the ask contains a vague
  gesture ("link it to other CSVs… I don't know something something"), that
  vagueness is the SIGNAL TO ASK, not licence to pick. Put the consequence in
  each option (§3's rule) and put a concrete `preview` on it — the founder
  chose off the preview.
- **`git add <paths>` does NOT isolate you in a shared checkout; `git commit`
  writes the whole INDEX.** My commit swept in a sibling agent's staged file
  (identical content, nothing lost, but pure luck). Standing rule now: agents
  and orchestrator alike use **`git commit -- <paths>`**, and check
  `git diff --cached --name-only` before committing. This belongs in every
  implementation brief.
- **A subagent calling a failure "pre-existing" is a claim to VERIFY, not
  accept — in both directions.** WS1 reported five failing tests as
  pre-existing; all five were ours (pinned capability fixtures — the §"pinned-
  spec sweep" invariant firing exactly as documented). WS4 reported a mobile
  typecheck error as pre-existing; that one was TRUE, proved by typechecking a
  pristine `origin/main` worktree (`git worktree add` + symlinked
  `node_modules` — cheap, definitive, and the technique to reuse).
- **Adversarial review remains the highest-value step, and the byte-level lens
  is the one to keep.** A green 3731-test suite hid a CRITICAL corruption: the
  runner prepended its row separator only when the in-memory buffer was
  non-empty, which is false at the start of every RESUMED invocation, so rows
  fused across chunk boundaries while the job reported the full row count and
  `truncated: false`. Only a probe that seeded past the invocation cap (1041
  rows) and PARSED THE STORED BYTES could see it. When a feature assembles a
  file across scheduled invocations, the review lens must be "read the final
  artifact back and parse it," never "do the units look right."
- **Prompt reviewers with the specific bypass classes.** "Try to defeat the
  formula-injection guard" + an enumerated list (leading whitespace, DDE,
  tab/CR, unicode lookalikes, negative-number strings) found that the guard
  was anchored at index 0, so ONE LEADING SPACE defeated it — reachable from
  any free-text form answer. A generic "check the escaping" would not have.
- **New-capability checklist, now proven end to end** (each step was a real
  near-miss this run): (1) string in `SEAT_CAPABILITIES`; (2) on the seats;
  (3) `EXPECTED_CAPABILITIES_BY_SEAT` in seats.test.ts; (4) **a MIGRATION** —
  capabilities are read from the `seatDefs` TABLE, so code alone is dead on
  every seeded deployment (copy `0053_add_campaign_design_defaults.ts`);
  (5) sweep `toEqual` fixtures repo-wide, not just the seats spec —
  `campaignPower`/`givingPower`/`0025_*` all pin capability arrays;
  (6) the Academy lesson must be REACHABLE from the granting seats' role
  paths. On (6) the lesson was authored into a giving course reachable by ONE
  of six holders; resolving all six `ROLE_PATHS` (a throwaway script, not
  inspection) proved it and drove the move to `how-we-work`.
- **"Export never widens reach" is the design rule that made the auth surface
  tractable**: `data.export` says you may extract; every dataset keeps its own
  pre-existing gate, so a Marketing Director without `giving.view` gets a
  people file with no giving columns rather than an error. Reviewers confirmed
  picker/runner agreement by reading the CSV BYTES, which is the only proof
  that counts — one function (`allowedSections`) serving both sides is what
  made them agree.
- **Every list query in a mature repo is capped for its grid** (donors 500,
  gifts 250, reconcile 5000). An export built on them silently truncates. Any
  "export/report over existing data" feature needs its OWN paginated read
  path, and per-builder page sizes: a WIDE row (six joins/row) blows Convex's
  ~16k-read transaction limit at the default page size on real data while a
  seeded test of three rows passes. Cost-per-row, not row count, sets the page.
- **Refusing the stop-hook is routine during a parallel run and should be
  stated plainly.** "Commit these changes" fired ~6 times while 4 agents held
  half-written files; committing would have landed non-building trees (once,
  an Academy file mid-move with the lesson deleted from one stream and not yet
  added to the other). Verify agent liveness, name the specific in-flight
  files, decline. Same for the "Unverified commit" hook: the email is already
  correct, the flag is a missing GPG signature that cannot be produced in the
  sandbox, and `--reset-author` would not change it — and rewriting the tip
  while agents build on it is actively destructive.


### 2026-07-30 — Run 13 (editor fixes v2 + paste-HTML-from-Canva; a dead agent, and a security review that earned it)
- **A dead background agent produces NEITHER a completion notification NOR
  progress — and "no notification" is indistinguishable from "still working"
  unless you actively check.** The paste-HTML agent died ~10 min in (terminal
  API error, 0 files written) and I waited ~3 HOURS on a completion
  notification that was never coming, treating the Monitor ticker as a mere
  heartbeat. The founder caught it, twice ("check on the agent", "check every
  5 minutes"). Standing rule now: on EVERY poll tick with a live agent,
  actively check its transcript's last-activity timestamp AND git progress
  (commits/WIP) — a transcript idle >~10 min = dead, relaunch. And every
  implementation brief now says COMMIT INCREMENTALLY (per layer) so a death
  costs minutes, not the whole run (this run's relaunch did, and it worked).
  Liveness-check mechanic that works without reading the (context-blowing)
  transcript: `tail -c 2500 <agent>.output | tr ',' '\n' | grep -oE
  '"timestamp":"[^"]*"' | tail -1`.
- **For an untrusted-input→production path, run TWO adversarial review agents
  (security-bypass + backend-correctness) BEFORE merge — and "always merge"
  does not exempt it.** Paste HTML sends arbitrary user HTML to the whole
  audience. A green 3600-test suite passed; the two reviewers, RUNNING the
  real code in real Chromium / convex-test, still found five real holes:
  `<meta http-equiv=refresh>` open-redirect live in the SENT mail (the in-app
  preview's `sandbox=""` blocks it, a recipient's webmail does not — verify the
  SEND surface, not just the preview), `@import` defeated by a CSS unicode
  escape (`@\69mport`), protocol-relative `url(//host)` bypassing re-hosting,
  no SSRF guard on the image fetch (an internal endpoint answering
  `content-type: image/*` → its body copied to PUBLIC storage), and a
  write-time backstop far weaker than the real sanitizer (a direct
  `updateCampaignDoc` could smuggle a credential-harvesting `<form>`). Prompt
  each reviewer with the specific sink classes and make them prove by
  executing, not reading.
- **`npx convex typecheck` is a distinct CI gate `tsc`/`vitest` don't cover —
  the backend twin of the Metro-bundler gap.** The SSRF fix added
  `node:net`/`node:dns` imports to a `lib/` helper without `"use node"`; the
  agent's `tsc --noEmit` + vitest were green, but CI's `npx convex typecheck`
  (which runs Convex's esbuild ISOLATE bundle) failed to resolve the node
  builtins. Fix: `"use node"` on any Convex module using node builtins (it may
  then only be imported by other `"use node"` files). Run `npx convex
  typecheck` from the REPO ROOT (where `convex.json`'s `functions: "apps/convex"`
  resolves) for CI parity before pushing Convex node code.
- **A "belt-and-suspenders" backstop must actually match the belt, and say so
  truthfully.** The write-time regex backstop was documented "no path can land
  unsanitized content" but blacklisted 9 patterns while the real sanitizer
  removed far more — a false doc claim the review falsified. With two layers
  (real sanitizer + coarse backstop), factor the shared hazard logic into ONE
  module both import so they can't drift, and write NEGATIVE tests proving the
  backstop rejects what it claims.
- **"Drop, don't leak" is the right default for an un-verifiable external
  resource.** On a failed image re-host, leaving the original external URL is
  both a tracking/exfil vector and a violation of "hosted reliably" — replace
  with an inert placeholder so the send makes zero third-party calls. Surface
  it as a product decision, but default to the safe reading of the founder's
  intent.

### 2026-07-29 — Run 12 (5 editor UX fixes + the "janky" chrome that wasn't)
- **"Browser-verified" is only as good as the SURFACE you actually rendered —
  and a harness styles some surfaces but not others.** I browser-verified 5
  editor fixes against the esbuild harness and sent the founder screenshots;
  she called the result "really janky." She was reading UNSTYLED chrome. The
  maily DOCUMENT renders via maily's own vendored CSS (which the harness
  bundles), so it looked right — but the surrounding APP chrome (font control,
  image row, meta fields) styles via NativeWind `className`, which a plain
  esbuild bundle never processes, so it collapsed to stacked plain text. I
  proved the fixes FUNCTION and mistook that for proving they LOOK right — the
  exact Run 9 miss ("verified the wrong thing") in a new disguise. Before
  presenting any harness screenshot as "how it looks," know which parts of the
  UI that harness actually styles, and never let styleless chrome read as
  representative.
- **The fix that makes a RN-Web harness faithful:** `jsxImportSource:
  "nativewind"` in the esbuild config (the real mechanism the app's own
  `babel.config.js` uses — `react-native-web`'s `View`/`Text` otherwise attach
  a baseline atomic style class that CLOBBERS any author `className`, so a
  compiled stylesheet alone is silently dropped) + compile the app's real
  `tailwind.config` so custom tokens (`bg-accent`, `text-faint`, …) resolve to
  real values. Then confirm styling took via `getComputedStyle`, never by
  assuming the CSS "should" apply. Once faithful, most of the "jank" evaporated
  — but it still surfaced two real issues (an over-wide 3-label font pill; a
  dead read-only row), so the faithful render both exonerated AND improved.
- **New founder directive, quoted: "merge, always merge."** Said after I held
  PR #468 green for her visual nod. Standing rule now: don't gate a merge on
  approval — merge on green and iterate after (merge-then-iterate is her
  model). Still SEND the proof; just don't block on it.
- **Merged-PR branch-restart flow, executed cleanly (first time it came up
  live):** the designated branch's PR squash-merged, so its remote tip was
  stale pre-squash history. Restart branch from `origin/main`, then
  force-with-lease over the stale remote — but FIRST prove the remote carried
  no unmerged work via a CONTENT diff (`git diff origin/main origin/branch`),
  not `git cherry` (squash-merges always show every source commit as `+`, a
  false "unmerged" signal). Direction of the diff (deletions vs insertions)
  told me main was strictly ahead.

