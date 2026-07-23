# Chore: Fix outdated Supa framework references in README

## Chore Description
`README.md` still describes the Supa framework as it existed before the org
and package scope were finalized. Both `CLAUDE.md` and `.claude/PROJECT.md`
already reference the correct org (`Supa-Media`) and package scope
(`@supa-media/*`), so the README is now internally inconsistent with the rest
of the repo's documentation. This is a docs-only correction — no code,
config, or behavior changes — that brings three stale references in
`README.md` in line with reality:

1. The framework link (line 7) points at `https://github.com/lilseyi/supa-framework`,
   but the framework has moved to `https://github.com/Supa-Media/supa-framework`.
2. The package-scope callout (line 8) says packages are published as
   `@supa/*`; they are actually published as `@supa-media/*` (see
   `CLAUDE.md`'s "Supa Framework" section and `.claude/PROJECT.md`'s Stack
   table).
3. The install comment (line 17) tells a developer that `pnpm install`
   requires a `GITHUB_TOKEN` with `read:packages` for `@supa/*` — the scope
   in that comment must also become `@supa-media/*`.

## Scope
**In scope:**
- `README.md` lines 7, 8, and 17 exactly as described above.

**Out of scope:**
- Any other occurrence of `lilseyi` in the repo. A repo-wide grep for
  `lilseyi` also turns up hits in `apps/convex/lib/seed/historical/ptb.ts`
  (unrelated seed data — a person's name/Venmo handle), `apps/landing/README.md`
  (a reference to the separate `lilseyi/public-worship` landing-site repo, not
  the Supa framework), `apps/mobile/app.config.js` (the Expo/EAS `owner`
  field, an account name — not the Supa framework repo), and several
  `docs/plans/*.md` files (historical planning docs referencing a local
  checkout path or the `public-worship` repo). None of these are Supa
  framework references and none should be touched by this chore.
- Any occurrence of `@supa/` outside `README.md` — a repo-wide grep found none.
- `apps/landing/README.md` — its `lilseyi/public-worship` reference is a
  different repo (the landing site's predecessor), not the Supa framework;
  leave it untouched.
- Any code, config, `package.json`, `.npmrc`, or CI workflow changes — this is
  a docs-only fix, and the actual `@supa-media/*` package scope / registry
  config elsewhere in the repo is already correct.

## Relevant Files
- `README.md` — contains all three stale references to fix:
  - Line 7: `Built on **Convex + Expo** via the [Supa framework](https://github.com/lilseyi/supa-framework)`
  - Line 8: `` (`@supa/*`). Standalone repo; the first real consumer of the framework. ``
  - Line 17: `pnpm install        # requires GITHUB_TOKEN with read:packages for @supa/*`

Searches used to confirm this is the complete list of occurrences:
```bash
git grep -n "lilseyi"
git grep -n "@supa/"
```
Both were run against the repo root; the `lilseyi` hits outside `README.md`
are unrelated (see "Out of scope" above), and the `@supa/` search returned
only the two `README.md` hits (lines 8 and 17).

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Fix the framework link (README.md line 7)
Change:
```md
Built on **Convex + Expo** via the [Supa framework](https://github.com/lilseyi/supa-framework)
```
to:
```md
Built on **Convex + Expo** via the [Supa framework](https://github.com/Supa-Media/supa-framework)
```

### 2. Fix the package-scope callout (README.md line 8)
Change:
```md
(`@supa/*`). Standalone repo; the first real consumer of the framework.
```
to:
```md
(`@supa-media/*`). Standalone repo; the first real consumer of the framework.
```

### 3. Fix the install comment (README.md line 17)
Change:
```bash
pnpm install        # requires GITHUB_TOKEN with read:packages for @supa/*
```
to:
```bash
pnpm install        # requires GITHUB_TOKEN with read:packages for @supa-media/*
```

### 4. Re-verify no stale references remain
Run the grep commands from "Relevant Files" again and confirm `README.md` no
longer appears in either result:
```bash
git grep -n "lilseyi" -- README.md
git grep -n "@supa/" -- README.md
```
Both must return no matches.

### 5. Run validation commands
Run the commands listed under Validation Commands below.

## Validation Commands
Execute every command. Every one must exit clean.

- `git grep -n "lilseyi" -- README.md` — must return no matches (exit code 1)
- `git grep -n "@supa/" -- README.md` — must return no matches (exit code 1)
- `git diff README.md` — must show exactly the three line changes described above and nothing else

Note: per `.claude/PROJECT.md`, the repo's install/test/typecheck/lint/build
commands (`pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`,
`pnpm lint`, `pnpm build`, etc.) cannot be run in this environment without a
`GITHUB_TOKEN` scoped to `read:packages` on the Supa-Media org. This chore
only touches `README.md` prose, so those commands are not required to confirm
correctness — the grep + diff checks above are sufficient. If a `GITHUB_TOKEN`
is available when this plan is implemented, running `pnpm turbo run lint` is
still a reasonable sanity check (it should be unaffected by a Markdown-only
change), but do not treat its unavailability as a blocker for this chore.

## Notes
- This is a pure documentation fix; no dependency, schema, or behavior change.
- The `lilseyi` and `@supa/` hits outside `README.md` (see "Out of scope")
  are pre-existing and intentionally left alone — they refer to a different
  repo, a person's name, or an Expo/EAS account owner field, not the Supa
  framework.
- Created as a small end-to-end test of the ADW pipeline.
