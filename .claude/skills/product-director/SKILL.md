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

### 2026-07-24 — Run 4 (receipt archive + duplicate flow + txn search)
- Founder feedback run: 3 recon lanes (duplicate-flow trace, search/linking
  trace, meta survey) → one sonnet implementation agent with recon-anchored
  brief → first-try-green (3120 tests). The duplicate-warning bug had a
  crisp root cause recon nailed before implementation: computeSoftDuplicates
  grouped amount+date collisions but only excluded `duplicateDismissed`
  rows — resolved duplicates kept flagging their primary. Recon also found
  the linking layer was ALREADY many-to-many (pinned test existed) — the
  "can't attach second receipt" complaint was one `continue` line in a
  search query. Trace before designing; the fix is often smaller than the
  feedback implies.
- Two-program .d.ts visibility class: apps/mobile's typecheck compiles
  ../convex files reached via generated api types but loads only .d.ts
  files its OWN tsconfig names — an ambient declaration satisfying
  `npx convex typecheck` broke root `pnpm typecheck` (mobile task). CI
  missed it because the mobile job was path-skipped on convex-only PRs.
  Fix: name the declaration in apps/mobile tsconfig include. A triple-slash
  reference in the importing .ts did NOT fix it. Root `pnpm typecheck` is
  part of the local gate for a reason — run it from the repo ROOT (from
  /home/user it fails with NO_IMPORTER_MANIFEST).
- Stop-hook nuance: unverified-commit warnings on GitHub's own squash
  commits (noreply@github.com, branch reset onto main) are false positives —
  never rebase main's history; only reset-author YOUR unpushed commits.

### 2026-07-24 — Run 3 (backend scanned-PDF receipt OCR)
- Run shape: founder pointed at PR history ("scanned PDFs don't work, must be
  a backend way") → 4 parallel recon lanes (pipeline trace, PR archaeology,
  ONLINE library research, meta survey) → orchestrator spike → one sonnet
  implementation agent → verify → ship. PR archaeology earned its lane: the
  "impossible" server-side render was a REVERTED first commit inside #406
  (@napi-rs/canvas, native `.node` addon vs esbuild) with a dangling
  `externalPackages` entry still in convex.json — the constraint was "no
  native addons," not "no server rendering."
- SPIKE BEFORE DELEGATING when a library choice gates the design: 15 min of
  empirical checks (plain Node + vitest edge-runtime) settled @hyzyla/pdfium
  (MIT, WASM) with a two-tier init — default Node build in prod (fs-loads
  its wasm; needs `externalPackages`), `browser/base64` embedded-wasm build
  under vitest's @edge-runtime/vm (which emscripten detects as "browser").
  The brief then contained proven code, and the agent shipped first-try-green.
- `npx convex typecheck` must run from the REPO ROOT (root convex.json sets
  `functions: apps/convex`); from inside apps/convex it dies with
  `ENOENT scandir 'convex/'` — don't misread that as a code failure when
  spot-verifying an agent's claim.
- Stop-hook "commit and push" pressure while a subagent has in-flight edits:
  commit YOUR files only via explicit pathspec (`git commit -- <paths>`),
  never `git add`-all — and refuse to commit the agent's half-done tree.
- apps/mobile tests run under JEST, not vitest — brief the right command.
- Monitor `persistent: true` still timed out at ~30 min in this harness —
  expect to re-arm the ticker on the timeout notification.

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

### 2026-07-24 — Email-targeting assessment run (pre-#424) (combinations/exclusions, clunky UI)
- Assessment-only run (founder: "analyze and tell me the plan"). 3 recon
  lanes (UI sonnet, backend sonnet, meta haiku); synthesis stayed here; no
  implementation dispatched unbidden. Monitor ticker armed/stopped cleanly.
- When lanes conflict, the deeper lane wins only after spot-verification:
  meta lane claimed legacy guests audiences mis-resolve pending 0037;
  backend lane proved legacy guests still resolve correctly (raw-email rsvp
  scan, audienceResolve.ts:142-172) — the REAL hole is new attendance
  filters silently under-matching (personAttendsMatch reads rsvps.by_person,
  historical rows unlinked until manual 0037 runs in prod). Verified in code
  before asserting.
- New failure class named: SILENT AUDIENCE SHRINK — resolver paths that drop
  people with no preview counter (unlinked historical RSVPs, verifiedEmailOnly
  checking any-verified-address while resolveSendAddress may pick an
  unverified one, central scope + chapterId filter dropping the
  central-donor fallback, legacy `people` opt-out drops uncounted). Preview
  must count every exclusion class or founders read low counts as "broken."
- Founder symptom → schema gap was near-literal: "can't do combinations and
  exclusions of properties" = flat AND-only filter object + person-id-only
  excludes. Plan: additive `excludeFilters` (NOT) ships before OR-of-groups
  (shape change; must update approval snapshot hash in lockstep — #399
  drift lesson).
- Spec'd-but-unwired control class again: `chapterId` is in the UI's
  GROUP_FIELDS list yet no control renders it — grep GROUP_FIELDS-style
  registries against actually-rendered controls.
- UI clunkiness had an in-repo precedent fix: BlastComposerCard's 400ms
  debounce vs AudiencesView's none — cite sibling patterns in briefs so
  agents copy the house solution.

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

[Folded 2026-07-26: Run 2 (email readiness), Run 2 team-chat addendum, and
Run 1 addenda 2-3 — durable bits now live in the invariants (git
archaeology/shallow-clone, actions_list token cap, check-runs-not-status,
deploy-verification, stacked-PR "unstable") and principles 7/8. The
2026-07-23 "sandbox can't pnpm install (401)" constraint is LIFTED — full
local suites are the norm; the bundler still only runs in deploys.]

[Runs 1 and its addenda (2026-07-23) folded into the instructions above:
parallel recon with exact symptoms, schema-ready-but-UI-missing gaps,
principles 1/2/4, refactor-PR sequencing, `.gitignore` needs
`!.claude/skills/` for this file to be committable, parallelize across
files / serialize within a file, re-check queued briefs when a removal
lands mid-run, "remove X entirely" → inventory look-alike surfaces in the
PR body.]
