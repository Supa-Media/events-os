<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`apps/convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

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
