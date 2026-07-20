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
