# Chore: Clean up outdated documentation

## Chore Description

A full sweep of this repo's Markdown documentation (root docs, `docs/`, and
`.claude/PROJECT.md` as ground truth) was run to find factually outdated
content — wrong file paths, stale version numbers, dead links, and claims
contradicted by the current code. Two research passes covered every tracked
`.md` file:

- Root/config docs (`README.md`, `AGENTS.md`, `apps/landing/README.md`) —
  cross-checked against `package.json` files, `.npmrc`, `.github/workflows/`,
  and actual mobile/router code. **No factual issues found** — the prior PR
  (#364, "fix outdated Supa framework references") already corrected the
  Supa-framework claims in `README.md`.
- The `docs/` tree (`docs/design/`, `docs/guides/`, `docs/notion-reference/`,
  `docs/plans/*.md` — 25 planning docs) — cross-checked against
  `apps/mobile/lib/theme.ts`, `tailwind.config.js`, `packages/shared/src/`,
  `apps/convex/schema/`, and each plan doc's own status header. **Almost all
  of it is clean or already self-labeled** (`docs/plans/budget.md` says
  "RETIRED"; `docs/plans/custom-domain-event-pages.md` says "Superseded" and
  points at `url-consolidation.md`; the Notion-reference docs are explicitly
  historical source material, not live guidance).

One concrete, unambiguous staleness survived both passes:
**`docs/plans/giving.md`** still carries the header `**Status: building
(autonomous, 2026-07-14).**`, but the feature it describes (the `donations`
table, `donationsCents`/`donationsCount` rollups on `eventPages`) is live in
`apps/convex/schema/ticketing.ts` today, and two later, larger docs
(`docs/plans/giving-platform.md`, `docs/plans/giving-territories.md`) already
treat Giving as a shipped foundation they're extending. The "building" status
line is actively misleading to anyone reading the plan docs to understand
current state.

A second, smaller item: `README.md` line 22 ends with a dangling reference —
`"See the spec for the full product scope."` — with no link and no single
file named "the spec." The closest thing that exists is `docs/plans/`, which
holds the actual product/feature specs. This line should point somewhere
real instead of at a phantom singular "the spec."

## Scope

**In scope:**
- `docs/plans/giving.md` — correct the stale `Status:` header line.
- `README.md` — replace the dangling "See the spec…" sentence with a concrete
  pointer to `docs/plans/`.

**Out of scope (explicitly do not touch):**
- Any rename between "Events OS" and "Chapter OS." The UI (e.g.
  `apps/mobile/components/ui/AppShell.tsx`) renders the literal string
  "Chapter OS," while `README.md`, `docs/design/TOKENS.md`, and
  `.claude/PROJECT.md` (regenerated 2026-07-21, i.e. two days before this
  chore) all use "Events OS." `.claude/PROJECT.md` explicitly frames this as
  "**Events OS** (internal name 'Chapter OS')," and
  `docs/plans/chapter-os-rebrand-and-schema-clarity.md` is an open, undecided
  "DISCUSSION DRAFT" proposing a full rebrand (including an `eventTypes` →
  `templates` schema rename that has not happened). This is a live product
  decision, not a documentation bug — do not resolve it as part of this
  chore.
- Any of the other 24 `docs/plans/*.md` files — each carries its own accurate
  status marker (PROPOSED / DISCUSSION DRAFT / DECIDED / IN PROGRESS /
  shipped) and, where spot-checked against code, matches what's shipped.
- `docs/guides/*.md`, `docs/notion-reference/*.md`, `docs/design/TOKENS.md`,
  `docs/agent.md`, `AGENTS.md`, `apps/landing/README.md`,
  `.claude/PROJECT.md` — all verified clean in this sweep; do not edit them.
- `specs/*.md` — these are historical per-chore/per-feature implementation
  records (this repo's convention is to keep them after merge, e.g.
  `specs/fix-readme-supa-framework-references.md` from PR #364 is still
  present). They are not live documentation and are not in scope for a
  "clean up outdated docs" sweep.
- Prose rewrites, reformatting, or reorganizing any file beyond the specific
  lines named below. No opportunistic cleanup.

## Relevant Files

- `docs/plans/giving.md` — line 3 has the stale status header that must be
  corrected.
- `README.md` — line 22 has the dangling "See the spec…" sentence that must
  be replaced.

Search commands used to build and verify this scope (re-run to confirm
nothing new has landed since this plan was written):
```bash
git ls-files | grep -iE '\.md$'
grep -rn "Status:" docs/plans/*.md
grep -rnoE '\]\(([^)]+\.md[^)]*)\)' --include='*.md' .   # dead-link check
```

## Step by Step Tasks

### 1. Fix the stale status header in `docs/plans/giving.md`

- Open `docs/plans/giving.md`. The current line 3 reads:
  ```
  **Status: building (autonomous, 2026-07-14).** First roadmap feature after the
  ```
- Confirm the feature is live before editing: `grep -n "donationsCents\|donations" apps/convex/schema/ticketing.ts` should show the `donations` table and the `donationsCents`/`donationsCount` fields on `eventPages`.
- Replace the status clause (keep the rest of the sentence — "First roadmap
  feature after the Academy redesign..." — intact) so it reads:
  ```
  **Status: shipped.** The `donations` table and `eventPages.donationsCents`/
  `donationsCount` rollups described below are live in `schema/ticketing.ts`.
  This was the first roadmap feature after the
  ```
  i.e. only change the bolded status clause; do not rewrite the rest of the
  paragraph, and do not touch anything past this sentence in the file.

### 2. Fix the dangling "See the spec" line in `README.md`

- Open `README.md`. The current line 22 reads:
  ```
  See the spec for the full product scope.
  ```
- Replace it with a pointer to the directory that actually holds the specs:
  ```
  See `docs/plans/` for the product and feature specs.
  ```

### 3. Verify no other occurrence of the stale pattern was missed

- Run `grep -rn "Status: building" docs/plans/*.md` — should return no
  results after step 1.
- Run `grep -n "See the spec" README.md` — should return no results after
  step 2.

### 4. Run the Validation Commands below.

## Validation Commands

Execute every command. Every one must exit clean. (Per `.claude/PROJECT.md`,
these require a `GITHUB_TOKEN` with `read:packages` for the Supa-Media org —
`pnpm setup:secrets` or an equivalent PAT — before `pnpm install` will
succeed. If that token is unavailable in the execution environment, the
markdown-only greps above are the substantive check for this chore; still
attempt the commands below and report their actual status rather than
skipping them.)

- `grep -rn "Status: building" docs/plans/*.md` — must return no results
- `grep -n "See the spec" README.md` — must return no results
- `pnpm --filter @events-os/shared test` — no doc content is asserted on by
  this suite, but it's the fastest workspace check that the repo still
  installs/builds cleanly; zero regressions expected since no source files
  changed
- `git diff --stat` — confirm only `docs/plans/giving.md` and `README.md`
  were touched

## Notes

- This chore intentionally found (and fixed) very little: the prior PR #364
  already resolved the Supa-framework staleness in `README.md`, and the rest
  of the doc tree is either accurate or already self-labeled as historical.
  Resist the urge to expand scope — the "Out of scope" list above exists
  specifically to keep this chore from ballooning into an unreviewable sweep.
- The "Events OS" vs. "Chapter OS" naming inconsistency (see Scope) is a
  real, repo-wide inconsistency but is a pending product/branding decision
  tracked in `docs/plans/chapter-os-rebrand-and-schema-clarity.md`, not a doc
  bug. Flag it to the user; do not resolve it here.
- No pre-existing test failures are known for the two touched-adjacent
  workspaces; `.claude/PROJECT.md` notes that no command could be verified
  locally in the environment it was generated in (missing `GITHUB_TOKEN`). If
  that's still true in the implementing environment, note it rather than
  attributing any resulting failure to this chore's changes.
