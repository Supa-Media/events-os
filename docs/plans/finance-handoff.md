# Chapter OS — Finance system handoff (v3, post finance-v2 program)

You're picking up the **native finance system** in Chapter OS (repo `~/Code/events-os`,
Convex + Expo/react-native-web monorepo). The finance-v2 program (2026-07-16, ~50 PRs
#128–#175) is COMPLETE and live on prod (`vivid-rhinoceros-688`). Your job: the residual
queue below + whatever the owner asks next. Read fully before touching finance code.

## Read first (in order)
1. `docs/plans/finance-v2-split-prd.md` — the owner-approved product spec (the split,
   plan→approve→spend→reconcile, playbook constants, seats). THE source of truth on intent.
2. `docs/plans/split-runbook.md` — split-day operational checklist (not yet executed;
   waits on 20 backers + a hired Chapter Director).
3. `docs/plans/transfers-ops-notes.md` — correcting mis-recorded transfers (no undo mutation).
4. `docs/plans/link-migration-runbook.md` — the executed link migration (phase B pending).
5. `apps/convex/_generated/ai/guidelines.md` — Convex rules that override training.

## The model (post-v2, memorize this)
- **One home per dollar**: `transactions.budgetId` is the ONLY attribution pointer.
  `eventId`/`projectId` FKs are DEAD (unwritten since #171; columns await phase-B drop).
  Reconcile has one "For" picker (Events/Projects/Recurring; picking a budget-less ref
  summons its $0 budget — bookkeeper rank, accepted expansion).
- **Budgets row = single source**: `events.budget`/`projects.budgetUsd` are mirrors written
  only by `setBudgetAmount` (finances.ts). Training events are field-only (never rows).
- **Approval workflow**: draft→submitted→approved/changes_requested; chapter budgets →
  Chapter Director/Treasurer (manager rank), central → ED/FM (specialized roles); identity
  SoD; **amount increases retrigger approval and the OLD approvedCents drives every numeric
  surface (`effectiveCapCents`) until re-approved**; grandfathered budgets retrigger on
  first increase.
- **Central**: string sentinel `"central"` everywhere incl. transactions (#151). Central has
  its own Increase account (provisioning ready, NOT yet run — see owner items).
- **Cards**: account-scoped (cash physics); attribution crosses scopes; `interScopeBalances`
  + `settlement` transfers true-up the cash (settle monthly alongside the 15% skim).
  Lifecycle: self-serve freeze, FM/Treasurer cancel, request-a-card. Wallet RTD handlers +
  PAN reveal (holder-only, 5/hr) shipped. Card-art pipeline inert until art uploaded.
- **Explicit-only attribution**: derive-matching is dead; unattributed spend is a loud
  first-class bucket. Money invariants unchanged (integer cents, flow-not-sign, transfers
  excluded from spend, ConvexError, SoD).

## How to work here (hard-won discipline — follow it)
- **Orchestrate**: one WP = one PR = one sonnet agent in an isolated worktree
  (`.claude/worktrees/<name>`), partitioned by FILE OWNERSHIP (two agents never share
  finances.ts). Opus for money-critical reviews + the rare judgment-heavy build; haiku for
  copy/content. NEVER Fable for workers.
- **Reviews parallel, merges serial**: dispatch an adversarial review the moment a PR opens;
  fix-pass agents run concurrently; the merge turnstile is sequential (merge = prod deploy —
  WATCH it green). Clean rebase → merge without re-review.
- **Review cycle is mandatory** (owner rule). It caught real money bugs in ~90% of PRs.
- **Live smoke gates phases**: convex-test is blind to UI/route/interaction bugs (a member
  hard-crash shipped past 900 green tests). Playwright pass before/after big UI waves:
  `npx convex dev` FROM REPO ROOT (from apps/convex it silently pushes zero functions),
  `npx expo start --web` from apps/mobile, DEV_OTP_BYPASS 000000, seyi@publicworship.life.
- **Money-gating**: merges must never auto-fire money. Movement requires active account +
  destination/key + human initiation. REPAYMENT_DEBIT_ENABLED=false until a debit state
  machine exists.

## Gotchas (will waste your time otherwise)
- `finances.ts` has non-ASCII bytes → plain grep returns NOTHING; always `grep -a`.
- Fresh worktrees: `GITHUB_TOKEN=$(gh auth token) pnpm install` (private @supa-media registry).
- Convex MCP reports the WRONG prod deployment; real prod = vivid-rhinoceros-688.
  `npx convex run --prod fn '{}'` works locally and beats the GH workflow when GitHub's
  API is flaky (workflow "failures" during GH incidents are often infra, not code — retry).
- convex-test scheduled functions MUST be drained (`vi.useFakeTimers()` +
  `finishAllScheduledFunctions(vi.runAllTimers)`) or CI flakes. cards.test.ts has one known
  intermittent parallel-run flake (passes standalone).
- `packages/shared` lint fails pre-existing ("No files matching pattern '.'") — not yours.
- Secrets: 1Password `Events` vault (per-env fields dev/staging/production) → Sync Secrets
  workflow → Convex. Item TITLE must match the env-var name exactly (OPENROUTER_SECRET_KEY
  vs _API_KEY cost an evening). Never `convex env set` directly.

## Open queue
**Blocked on owner** (nag politely): (1) new prod INCREASE_API_KEY → 1Password → targeted
sync → then run `increase:backfillChapterAccounts` (creates central acct, adopts NY);
(2) RTD + digital-wallet-tokenization enablement request to Increase
(program_3lxxmr4tc9wazoonyi7y); (3) Visa-templated card art → then the #160 ops sequence;
(4) OpenRouter free-model data-retention decision (PII-minimized already, model id is a
one-line swap); (5) whether members should see reconcile notes (currently hidden).

**Agent-ready**: WP-U phase B (drop transactions.eventId/projectId columns + indexes —
verify zero readers first); type moneyViews.refMoney's dynamic approvalStatus read
(post-#173/#174 reconciliation); projects-peek UI surface (backend ready; Work-tab has no
foreign-chapter rendering — needs a small product decision); event-detail peek (deep
requireOwned refactor — bigger); repayment-debit state machine (unlocks
REPAYMENT_DEBIT_ENABLED); cards.test.ts parallel flake; WP-3.5 chapter budget template +
WP-4.4 conference sinking fund (only unbuilt PRD items — small); Giving page (F-6, separate
PRD when owner is ready — backer counts feed the affordability header).

**The split itself** = a working session with the owner per split-runbook.md.

## Owner working preferences (see memory for full list)
ASCII wireframes BEFORE building UI; no null sentinels (string sentinels); never merge
without review; watch deploys to green; parallelize aggressively with file partitioning;
plain-language explanations for model/design decisions — the owner redirects fast and well.
