# Chapter OS — Finance system handoff (for the next agent)

You're picking up the **native finance system** in Chapter OS (repo `~/Code/events-os`,
a Convex + Expo/react-native-web monorepo). It's built, merged, and live in
production; your job is to **refine and extend the financial functions**. This is
your orientation — read it fully before touching finance code, then read
`docs/plans/finance.md` (the build/UI spec, the prototype is the source of truth)
and `apps/convex/_generated/ai/guidelines.md` (Convex rules that override training).

---

## What this is

A native money layer that replaces KleerCard/Bill.com. Because the app already holds
events, projects, supplies, teams and people, **every dollar attaches to the exact
event/project/item it was spent on**. Six phases shipped (PRs #89–#94), then the
Increase integration was grounded against the real API and hardened (#95–#103).

**Money model (authoritative):**
- **Increase** = the money layer: ACH reimbursement payouts AND member cards.
  Structure: **one shared org Entity** (the legal nonprofit "Global Echo Charitable
  Co", KYB-verified once in the Increase dashboard, env `INCREASE_ENTITY_ID`); each
  **chapter is an Account** opened under that one Entity (no per-chapter KYB). The
  app NEVER creates Entities.
- **Stripe Financial Connections** = READ-ONLY sync of legacy/external bank+card
  accounts (Increase can't aggregate outside accounts). Reuses `stripe.ts` +
  `/stripe/webhook`. **No Stripe Issuing / Connect** anywhere.
- **Budgets = scope × cadence × categories** (one flexible `budgets` table). scope ∈
  event/project/template/team/bucket/chapter; cadence ∈ per_instance/monthly/quarterly/
  yearly/one_off.

**Non-negotiable invariants (enforced + tested — keep them):**
- Money is **integer `amountCents`** (USD), never floats. Direction lives in `flow`
  (`outflow`/`inflow`/`transfer`), never a sign. `formatCents` is the only money→string.
- Every table is **chapter-scoped** (`chapterId` + `by_chapter` index). Exceptions:
  `webhookEvents` (deployment-wide dedup) and `financeSettings` (deployment-wide singleton).
  **"Central" is modeled as the org level = `chapterId: null`** (see "Open work").
- **Anti-double-count:** `transactions` is the ONLY table summed for Actual. Estimated
  (budgets / `projects.budgetUsd` / `events.budget` / item costs / engagement amounts)
  is NEVER summed with Actual. `flow:"transfer"` rows are excluded from category/budget
  spend (`countsAsSpend`). A reimbursement payout posts as a transfer; a personal-charge
  repayment posts an offsetting transfer credit.
- **Authz** (`lib/finance.ts`): graded ladder `viewer < bookkeeper < manager` + a
  `central` scope + superuser-implicit-manager; **separation of duties** (approver ≠
  requester, payer ≠ payee). Every finance function gates + verifies every client id is
  in the caller's chapter. Failures are `ConvexError` (never plain `Error`) so the
  app's AuthErrorBoundary can recover.
- Enum tuples live in `packages/shared/src/finance.ts`; schema validators are built
  from them via `v.union(...TUPLE.map(v.literal))` (the `EVENT_STATUSES` pattern).

---

## Where things live

**Backend (`apps/convex/`):**
- `schema/finances.ts` — all finance tables (funds, budgetCategories, financeTeams,
  budgets, transactions, reimbursementRequests/LineItems, cards, personalRepayments,
  payouts, increaseAccounts, legacyAccounts, cardAuthorizations, approvalPolicy,
  approvals, financeRoles, webhookEvents, financeSettings). Registered in `schema.ts`.
- `lib/finance.ts` — the authz helpers (`requireFinanceRole`, `requireFinanceManager`,
  `requireFinanceCentral`, `resolveCallerPersonId`, `assertSeparationOfDuties`).
- `finances.ts` — funds/categories/teams/budgets CRUD; transactions list(paginated)/
  createManual/categorize/bulkCategorize/setStatus/attachReceipt/flagPersonal; the
  read rollups `dashboardChapter`/`dashboardCentral`/`budgetVsActual`/event|project|
  teamActuals/`personTransactions`.
- `financeSettings.ts` — deployment-wide `sandboxMode` singleton
  (`getFinanceSettings` viewer / `setSandboxMode` superuser / `readSandboxMode` internal).
- `aiCoding.ts` (`"use node"`) + `aiCodingData.ts` — AI auto-coding: `suggestCoding`
  (OpenRouter, bookkeeper-gated, degrades w/o key) + `acceptSuggestion`.
- `stripeFinance.ts` — Stripe FC: `createFcSession`/`storeFcAccount`/`syncTransactions`
  (cursor + dedup on `by_external_id`)/`listAccounts`/`setAccountFund`/`disconnect`.
- `reimbursements.ts` — public token-scoped submit/status/upload + in-app queue
  (list/get/preApprove/approve[partial]/reject/cancel, SoD, reminders cron).
- `increase.ts` — money layer: `provisionChapterAccount` (mode-aware), `payReimbursement`
  + `markPaidManually` (idempotent on reimbursementId), `onIncreaseWebhookEvent` +
  `handleIncreaseWebhook`, `verifyIncreaseSignature`, `getChapterAccount`, `listPayouts`.
  Helpers: `increaseEnvForObjectId(id)` (route by `sandbox_` prefix) + `increaseEnvForMode(sandbox)`.
- `cards.ts` — person-owned cards: issue/list/lock/setControls, `decideCardAuthorization`
  (real-time decision: monthly cap + validity + receipt-lock), personal repayment
  (flag + `initiateRepayment` + manager-only `markRepaymentPaid`), `autoLockOverdueCards`.
- `webhooks.ts` — shared inbound dedup (`recordWebhookEvent`).
- `http.ts` — routes: `/stripe/webhook` (checkout + `financial_connections.*`),
  `/increase/webhook` (Standard Webhooks; `real_time_decision.card_authorization_requested`
  synchronous, others dedup+async), `/reimburse/<slug>[?token=]` + `/api/reimburse/*`
  (`lib/reimbursePage.ts` + `lib/reimburseApiRoutes.ts`, mirror the ticketing landing page).
- `crons.ts` — FC sync backstop, reimbursement reminders, card receipt auto-lock.

**Shared:** `packages/shared/src/finance.ts` (enum tuples + `formatCents`/`sumCents`/
`countsAsSpend`/`financeRoleAtLeast`/`easternParts`/`quarterOfMonth`).

**UI (`apps/mobile/app/(app)/finances/`):** `_layout.tsx` (tab router + SandboxModeBanner),
`index.tsx` (dashboard: central/chapter/member), `reconcile.tsx`, `cards.tsx`,
`reimbursements.tsx`, `accounts.tsx` (Stripe FC connect + sandbox toggle + Provision
account). Components under `apps/mobile/components/finance/*`. Nav-gated admin/lead
(`AppShell.tsx`); the real gate is `financeRoles` server-side. This repo uses
NativeWind (`className`) + tokens in `apps/mobile/lib/theme.ts`. The clickable spec is
`~/Code/public-worship/public/artifacts/chapter-os/{finances,reimburse}.html`.

**Spec doc:** `docs/plans/finance.md` (money model + per-surface UI/data shapes).

---

## Increase integration — the important operational details

- **Grounded against the real API** (verified vs increase.com/documentation + the live
  sandbox). Standard Webhooks signatures: headers `webhook-id`/`webhook-timestamp`/
  `webhook-signature`; `verifyIncreaseSignature` HMAC-SHA256 over `{id}.{timestamp}.{body}`
  and **accepts the shared secret used raw OR base64-decoded** (Increase's "Shared Secret"
  field is ambiguous). Events dispatch by `category`; the object is NOT inline — you GET it.
- **ACH credits are terminal at `submitted`** on Increase (no `settled`/`paid`). Payout
  status mapping reflects that. Open TODO: a `submitted → returned` reversal path.
- **One endpoint, two environments.** The single prod webhook
  `https://vivid-rhinoceros-688.convex.site/increase/webhook` serves BOTH prod and sandbox
  Increase. A `sandbox_`-prefixed `associated_object_id` routes the follow-up API call to
  `sandbox.increase.com` with `INCREASE_SANDBOX_API_KEY` (`increaseEnvForObjectId`). The
  webhook shared secret is the same for both dashboards.
- **Runtime sandbox toggle** (`financeSettings.sandboxMode`, superuser, on the Accounts
  screen) drives NEW provisioning (`increaseEnvForMode`): sandbox → sandbox entity/key/
  base + `INCREASE_SANDBOX_ENTITY_ID`. **Existing accounts self-select their environment
  from their `sandbox_` id prefix**, so flipping the toggle can never misroute
  already-provisioned money. Program is auto-resolved per env (a nonprofit has one program);
  `INCREASE_PROGRAM_ID` / `INCREASE_SANDBOX_PROGRAM_ID` are optional per-mode overrides.
- **Env vars (on the prod deployment):** `INCREASE_API_KEY` (prod), `INCREASE_WEBHOOK_SECRET`
  (shared), `INCREASE_ENTITY_ID` (prod), `INCREASE_API_BASE` (prod api URL),
  `INCREASE_SANDBOX_API_KEY` + `INCREASE_SANDBOX_ENTITY_ID` (from the 1Password dev fields),
  `INCREASE_PROGRAM_ID`/`INCREASE_SANDBOX_PROGRAM_ID` (optional). All key-gated: finance
  degrades to a logged no-op when a vendor key is unset.
- **Sandbox ids** (for testing): entity `sandbox_entity_fyqn5ygrs6jrtitofxm9`, program
  `sandbox_program_uzcjf5ppbi33tgk3le35`. **Prod:** entity `entity_5ro1yfgknuuwjrtl38e9`
  (Global Echo Charitable Co), program `program_3lxxmr4tc9wazoonyi7y`.

---

## Current live state

- All 15 finance PRs (#89–#103) are **merged to main and deployed to prod**
  (`vivid-rhinoceros-688`). **579 convex-tests, typecheck green.**
- **Increase secrets are synced onto the prod deployment** via the Sync Secrets pipeline.
  The prod `/increase/webhook` is live and enforcing signatures (returns 400 on a bad sig).
- The Increase webhook is created in the dashboard ("all events"). **Sandbox mode is
  currently ON** for testing. A first sandbox chapter provision (New York) was being
  exercised; the request shapes are all sandbox-validated.

---

## Open work you're likely picking up (in priority order)

1. **CENTRAL vs CHAPTER model (the big one, decided but not built).** The owner's
   direction: "central is DIFFERENT from a regular chapter — different controls, structure,
   people; all chapters are uniform; central = the admins running the software." So model
   **central as the org level (`chapterId: null`), NOT a chapter** — reusing the existing
   `financeTeams` null-chapter precedent + the `financeRoles` `central` scope + superuser.
   Three deliverables:
   - **Gate Stripe FC "Connect a bank" + `legacyAccounts` to central/superuser.** Regular
     chapters get Increase accounts + cards ONLY; only central connects external accounts.
   - **Full-history Stripe FC sync.** On connect, backfill the ENTIRE transaction history
     (not just recent) and keep receiving new transactions ongoing. Current sync is a
     bounded newest-first re-sweep — add a first-connect full backfill (paginate to
     `has_more:false`, mark the account backfilled) then incremental.
   - **Central (org-level) budgets + a central-or-chapter budget picker** in reconcile/
     categorize, so anyone can send a transaction to a central budget OR their chapter budget.
2. **Provisioning: match existing accounts by name.** The prod Entity already has a "New
   York" account; `provisionChapterAccount` would create a duplicate. Before creating, list
   accounts under the entity and link the existing one by name (or store its id).
3. **Increase go-live TODOs** (breadcrumbed in `increase.ts`/`cards.ts`): full ACH
   destination capture (the reimburse form has only bank last-4 → external-account linking);
   `submitted→returned` payout reversal; confirm real-time card decisions are enabled on
   the Increase program.
4. **Live sandbox round-trip validation** (not yet exercised end-to-end): a card-auth
   simulation → real-time-decision, and an ACH payout → `ach_transfer.updated` → paid.

---

## How to work here

- **Orchestrator pattern.** Own the shared files (`schema.ts`, `schema/finances.ts`,
  `http.ts`, `crons.ts`, `packages/shared`, `AppShell.tsx`, `.env.example`) + define the
  contract; delegate each new module (one file, one owner) to a subagent on disjoint files.
  **TDD** with `convex-test` (`newT`/`setupChapter`/`run` from `tests/setup.helpers.ts`) —
  suite first (red), implement (green). Design/architecture decisions → ask the owner first.
- **Branch/PR/merge.** One feature branch + PR per change. **CI must be green** (`Test
  Convex Backend` + `Test Mobile App`). **Merge to main auto-deploys to PROD** (`vivid-
  rhinoceros-688`) — there is no staging Convex, so every merge is a prod deploy. Watch the
  `Deploy Convex (production)` run after merging (env-var changes need no redeploy; env is
  read at runtime).
- **Verify:** `pnpm typecheck` + `pnpm test` (turbo). Regenerate types with
  `npx convex codegen` (targets the LOCAL dev backend — safe, never prod). Every review is
  by adversarial subagents; findings get fixed or resolved before merge.
- **Secrets:** 1Password (`Events` vault, one Secure Note per env var, fields dev/staging/
  production) → the **Sync Secrets** GitHub workflow (`workflow_dispatch`, `OP_SERVICE_
  ACCOUNT_TOKEN` is a *production-environment* GitHub secret) → Convex `convex env set`.
  **Never `convex env set` directly** — always through the pipeline. The workflow has an
  optional `keys` input for a safe targeted run (e.g. just the `INCREASE_*` keys).
- **Sandbox testing:** the outbound side runs against the sandbox by flipping the sandbox
  toggle ON (or via a local dev backend with sandbox keys in `.env.local` via `op inject`);
  inbound webhooks all hit the prod endpoint and route by the `sandbox_` prefix. You can
  validate Increase request shapes directly with `op read op://Events/INCREASE_API_KEY/dev`
  + `curl https://sandbox.increase.com/...` (read-only; that's how the grounding was validated).

## Gotchas (things that will waste your time if you don't know them)

- **The Convex MCP points at the WRONG deployment.** It reports `prod = artful-echidna-883`,
  which is stale/empty. The REAL prod is **`vivid-rhinoceros-688`** (CLI `--prod` / GH
  deploy; webhook `.convex.site`). Do NOT trust MCP `logs`/`envList`/`runOneoffQuery` for
  prod — they read the wrong deployment. Use the Convex dashboard or the deploy-key CLI.
- **The interactive live smoke can't run in the dev env** (as of this writing): `pnpm dev`
  needs a private `@supa-media/dev` package that isn't installed; the local anonymous Convex
  backend had stale schema-incompatible data; `seedDemoData` requires an authenticated caller.
  Rely on `pnpm test` + typecheck + a clean Expo web bundle build + prod verification. If you
  need a live app, run `npx convex dev` + `npx expo start --web` directly (bypassing the wrapper).
- **`supa.config.ts` names the vault `EventsOS` but the real 1Password vault is `Events`** —
  the sync workflow hardcodes `Events`. (A cleanup worth doing.)
- Repo CI has historically been flaky/startup_failure on unrelated jobs; the required checks
  are `Test Convex Backend` + `Test Mobile App`.
- This repo is the **first consumer of the supa-framework** (`~/Code/supa-framework`); some
  workflows `uses:` the framework's reusable ones, but `deploy-convex` is kept self-contained
  because the private `@supa-media/convex` install needs `GITHUB_TOKEN` in `pnpm install`.
