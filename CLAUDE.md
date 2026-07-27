<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`apps/convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Agent Delivery Workflow

When asked to work on something, ship it end to end — don't park a branch:
develop on a feature branch → open a PR → review the diff (act only on
confirmed findings) → wait for CI → **squash-merge on green**. Merging to
`main` deploys the Convex backend to production, so never merge on red or
skip CI. This is the standing expectation; don't wait to be asked to PR or
merge.

**Polling while work is in flight (subagents, CI, deploys): use a
persistent background Monitor ticker. NEVER use `send_later` — for
anything.** It triggers a blocking permission prompt on every call on
claude.ai/code (the repo allowlist is ignored for CCR scheduling tools),
interrupting whoever is at the keyboard. Arm one session-length Monitor
(`while true; do sleep 300; echo "POLL TICK"; done`, persistent) and on
each tick check in-flight branches, CI check runs, and deploy workflows —
never passively wait for completion notifications and never take a
subagent's self-report on faith. For one-shot waits use Bash
run_in_background with an `until` loop. Stop the ticker when nothing is
outstanding.

## Gate It Behind a Power, Even When It's Open Today

**Whenever a capability might one day need to be restricted, put it behind a
named access function from the start — never inline the check, and never
hard-code "anyone can do this" at the call site.** "We'll add permissions
later" turns a one-file change into a fifty-call-site change, and the call
sites are where the misses happen.

The mechanism is the seat chart — seats are the single source of roles AND
permissions:

1. A power is a string in `SEAT_CAPABILITIES` (`packages/shared/src/seats.ts`).
2. Seats grant it via `SEAT_DEFS[seatId].capabilities`; a holder's effective
   set is the union of their assignments (`lib/seatStructure.ts#effectiveCapabilities`).
3. Each domain owns a resolver in `apps/convex/lib/<domain>Access.ts` exposing
   a `has<Thing>` / `require<Thing>` pair. Every call site uses the `require`
   form — nothing checks seats inline.

When the answer today is "anyone in the chapter," **still write the resolver**;
its body is just the membership check, with a comment saying which capability
name it will graduate to. Adding the real gate is then: add the string to
`SEAT_CAPABILITIES`, list it on the seats that should carry it, and change the
resolver's body. One file, no call-site churn, and the seat chart stays the
honest answer to "who can do this?"

Precedents to copy: `lib/campaignsAccess.ts` (`campaigns.compose` /
`campaigns.approve` — deliberately seat-capability-only so it can be
granted/revoked per seat at runtime), `lib/givingAccess.ts` (`giving.view` /
`giving.manage` / `nav.giving`), and the finance ladder in `lib/finance.ts`.

Two things this pulls in: a new capability is a **roles/seats change**, so the
Academy rule below applies; and separation-of-duties matters — if a power
approves something, the approver must not be the submitter (see
`campaigns.ts`'s state-machine doc).

## Supa Framework

This repo is the first consumer of **Supa-Media/supa-framework** (`@supa-media/*`
packages from GitHub Packages + reusable workflows pinned `@main`; local checkout:
`~/Code/supa-framework`).

- Consumed today: `@supa-media/convex` (auth via `createSupaAuth`, schema
  composables), `@supa-media/core` (providers), `@supa-media/dev` (powers
  `pnpm dev`), `@supa-media/linter`, `@supa-media/metro`, `@supa-media/notifications`,
  `@supa-media/testing` (CI guardrails), and the reusable `ci.yml` workflow.
- Private registry: installing `@supa-media/*` needs a `GITHUB_TOKEN` with
  `read:packages` (see `.npmrc`; CI passes `secrets.GITHUB_TOKEN`).
- **Upstream-first rule:** if a change touches behavior that comes from the
  framework (a package, bin, provider, or reusable workflow), do NOT patch or
  fork it here first. Ask: is the change generic? If yes → change it in
  supa-framework (PR there → release → `pnpm update "@supa-media/*"` here).
  Only implement locally when genuinely app-specific — and leave a comment
  explaining why it diverges.
- Updating: `pnpm update "@supa-media/*"`.
- `supa.config.ts` is the framework config surface — keep it truthful (vault
  name, EAS project id); `scripts/dev.js` loads it at runtime.

## The Academy Must Track the Product

The Academy (packages/shared/src/academy/) is the org's canonical training —
it teaches both the app and Public Worship's culture. It goes stale the moment
a documented behavior changes. **Every PR that changes user-facing behavior,
vocabulary, money rules, roles/seats, or org process must ask: "does the
Academy need updating?"**

- Renamed a concept, tab, or role? → grep the academy content for the old term.
- Changed a flow a lesson teaches (budgets, reconcile, cards, events, seats)?
  → update the lesson and its quiz in the same PR.
- Shipped a new user-facing feature? → decide explicitly: new lesson, new
  module, or "not training-worthy" (say so in the PR description).
- Changed seat definitions in packages/shared/src/seats.ts? → check the role
  paths (packages/shared/src/academyPaths.ts) cover the new/renamed seat.
- Capstone templates (apps/convex/lib/seed/templates.ts) reference real
  statuses/tabs — UI renames can silently break quests. Run the academy tests.

When unsure whether a change is "training-worthy," it probably is — err on
the side of updating. The integrity asserts catch structural drift; they
cannot catch a lesson that now teaches the wrong thing.
