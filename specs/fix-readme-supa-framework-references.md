# Chore: Fix outdated Supa framework references in README

## Chore Description
`README.md` still points at the old home of the Supa framework and its old
package scope. The framework moved from `lilseyi/supa-framework` to
`Supa-Media/supa-framework`, and its packages are published as `@supa-media/*`,
not `@supa/*`. This is already correct everywhere else in the repo (CLAUDE.md,
`.claude/PROJECT.md`, `.npmrc`, `package.json` dependencies) — only
`README.md` is stale. Fixing it removes a contradiction a new contributor
would hit in their first five minutes (wrong GitHub link, wrong package scope
in the install instructions). Docs-only change; no code or behavior is
affected.

## Scope
**In scope:**
- `README.md` line 7 — update the Supa framework link from
  `https://github.com/lilseyi/supa-framework` to
  `https://github.com/Supa-Media/supa-framework`.
- `README.md` line 8 — update the package scope from `` `@supa/*` `` to
  `` `@supa-media/*` ``.
- `README.md` line 17 — update the inline comment from `for @supa/*` to
  `for @supa-media/*`.

**Out of scope:**
- Any other `lilseyi` reference in the repo (personal GitHub username, unrelated
  repo names, local file paths, a seed-data Venmo handle) — these are not
  Supa-framework references and must NOT be touched. Confirmed occurrences
  that must be left alone: `apps/convex/lib/seed/historical/ptb.ts:16`,
  `apps/landing/README.md:2`, `apps/mobile/app.config.js:102`,
  `docs/plans/template-modules-roles-howto-redesign.md:58`,
  `docs/plans/url-consolidation.md:15,140,170,182`,
  `docs/plans/volunteers-database-redesign.md:16`.
- Any non-README file. `git grep -nE "@supa/"` outside `README.md` returns no
  hits, so no other file needs a package-scope fix.
- Any code, dependency, config, or CI change — this is a documentation-only
  fix.

## Relevant Files
- `README.md` — the only file with stale Supa-framework references; contains
  all three lines that need to change.

Search commands used to confirm this is the complete set of occurrences:
- `git grep -n "lilseyi" -- . ':!pnpm-lock.yaml'`
- `git grep -nE "@supa/" -- . ':!pnpm-lock.yaml'`

Both were run from the repo root; only `README.md` contains Supa-framework
references that need updating (the `lilseyi` hits elsewhere are unrelated, per
Scope above).

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Update the Supa framework link (README.md line 7)
Change:
```
Built on **Convex + Expo** via the [Supa framework](https://github.com/lilseyi/supa-framework)
```
to:
```
Built on **Convex + Expo** via the [Supa framework](https://github.com/Supa-Media/supa-framework)
```

### 2. Update the package scope reference (README.md line 8)
Change:
```
(`@supa/*`). Standalone repo; the first real consumer of the framework.
```
to:
```
(`@supa-media/*`). Standalone repo; the first real consumer of the framework.
```

### 3. Update the install comment (README.md line 17)
Change:
```
pnpm install        # requires GITHUB_TOKEN with read:packages for @supa/*
```
to:
```
pnpm install        # requires GITHUB_TOKEN with read:packages for @supa-media/*
```

### 4. Verify no stale references remain and run validation
Run the Validation Commands below.

## Validation Commands
Execute every command. Every one must exit clean.

- `git grep -nE "lilseyi/supa-framework|[^-]@supa/\*" -- README.md` — must
  produce **no output** (exit code 1), proving the stale link and package
  scope are gone from `README.md`.
- `git diff README.md` — must show exactly the three line changes described
  above and nothing else.

Note: per `.claude/PROJECT.md`, this environment has no `GITHUB_TOKEN` with
`read:packages` for the Supa-Media org, so `pnpm install`, `pnpm turbo run
test`, `pnpm turbo run build`, and all other package-manager-driven commands
cannot run here. This chore is a docs-only, textual change to `README.md`
and does not affect any code path those commands would exercise, so their
unavailability does not block this chore. CI (which does have the token)
will still run its normal suite on the PR.

## Notes
- No dependencies are added or changed.
- No pre-existing test failures are relevant — this chore touches only
  `README.md` prose.
- The `lilseyi` occurrences outside `README.md` are intentionally left as-is
  (see Scope) — they refer to the maintainer's personal GitHub account, an
  unrelated repo (`lilseyi/public-worship`), local file paths, and seed/test
  data, none of which are Supa-framework references.
