# Chore: add house-style module comments to undocumented Convex modules

## Chore Description

This repo's documentation convention (`.claude/PROJECT.md` → "Documentation
density is high and deliberate") is that nearly every module opens with a
`/** ... */` block comment explaining *why* the module exists, what it
supersedes, and what would break if removed. The originating request listed
eight `apps/convex/` modules as lacking this comment:

- `aiActions.ts`, `aiCoding.ts`, `auth.config.ts`, `auth.ts`, `http.ts`,
  `oneoffDedupeRelay.ts`, `schema.ts`, `vitest.config.ts`

**Research finding — the premise is only true for 2 of the 8 files.** Reading
each file in full (required by this command's own research step) shows six of
the eight already carry a compliant house-style comment:

| File | Status |
|---|---|
| `aiActions.ts` | ✅ Already has one (after `"use node";`, lines 3–16) |
| `aiCoding.ts` | ✅ Already has one (after `"use node";`, lines 3–24) |
| `auth.config.ts` | ❌ **No block comment — genuinely undocumented** |
| `auth.ts` | ✅ Already has one (after the import, lines 3–9) |
| `http.ts` | ❌ **No block comment — genuinely undocumented** |
| `oneoffDedupeRelay.ts` | ✅ Already has an unusually thorough one (lines 4–37) — it already says it's a one-off (dated 2026-07-17) and is dry-run guarded. Nothing to add. |
| `schema.ts` | ✅ Already has one, placed after the ~94 lines of per-domain imports and directly before the `defineSchema({...})` call it documents (lines 96–121) — the same "comment immediately before the code it explains" position `auth.ts`/`vitest.config.ts`/`aiActions.ts` all use. It satisfies "opens with a block comment" in the sense this repo's other compliant files do. |
| `vitest.config.ts` | ✅ Already has one (after the import, lines 3–9) |

Only `auth.config.ts` and `http.ts` are missing a module-level "why" comment.
This chore is **rescoped** to those two files. Do not touch the other six —
editing them would violate "No non-comment lines changed" for no benefit, since
they already meet the house-style bar this chore exists to enforce.

**Report this rescoping explicitly in the PR description** — the person
reading the diff should know why it touches 2 files, not 8, and that this was
verified by reading each file, not assumed.

## Scope

**In scope:**
- Add a leading `/** ... */` block comment to `apps/convex/auth.config.ts`
- Add a leading `/** ... */` block comment to `apps/convex/http.ts`

**Out of scope:**
- `aiActions.ts`, `aiCoding.ts`, `auth.ts`, `oneoffDedupeRelay.ts`, `schema.ts`,
  `vitest.config.ts` — already compliant, do not edit.
- Any behavior change, refactor, or rename in either in-scope file.
- Any change to `oneoffDedupeRelay.ts`'s continued existence/deletion — that's
  a separate decision outside a comment-only chore.

## Relevant Files

- `apps/convex/auth.config.ts` — 9-line Convex JWT-issuer config; needs a
  block comment.
- `apps/convex/http.ts` — 501-line public HTTP surface; needs a block comment
  above its first import. (Its individual routes already have good inline
  `// ── Section ──` comments — leave those untouched.)
- `apps/convex/_generated/ai/guidelines.md` (read-only reference, line 162) —
  confirms why `auth.config.ts` is required: *"Convex supports JWT-based
  authentication through `convex/auth.config.ts`. ALWAYS create this file when
  using authentication. Without it, `ctx.auth.getUserIdentity()` will always
  return `null`."*
- `apps/convex/eventTypes.ts` and `apps/convex/lib/access.ts` — house-style
  reference examples named in the original request.
- `apps/convex/auth.ts`, `apps/convex/aiActions.ts`, `apps/convex/schema.ts`,
  `apps/convex/vitest.config.ts` — additional in-repo reference examples for
  tone/format (comment goes after any required top-of-file directive/import,
  before the first substantive declaration; em dash in the opening line;
  short paragraphs; backticked identifiers).

Search commands used to build/verify this file list:
```
git ls-files apps/convex/aiActions.ts apps/convex/aiCoding.ts apps/convex/auth.config.ts \
  apps/convex/auth.ts apps/convex/http.ts apps/convex/oneoffDedupeRelay.ts \
  apps/convex/schema.ts apps/convex/vitest.config.ts
# → confirmed all 8 paths exist as given
head -20 <each file>   # → confirmed comment presence/absence per the table above
```

### New Files
None.

## Step by Step Tasks

### 1. Add a block comment to `apps/convex/auth.config.ts`

Current file:
```ts
export default {
  providers: [
    {
      // The local/cloud Convex deployment's site URL is the JWT issuer.
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
```

Insert a `/** ... */` block comment above the `export default`. It must
cover, in prose (do not just restate the object shape):
- What this file is: the Convex JWT-issuer config required by
  `@convex-dev/auth` (wired here via `@supa-media/convex`'s `createSupaAuth`
  in `auth.ts`) for verifying the identity tokens Convex itself issues.
- What breaks without it: per `apps/convex/_generated/ai/guidelines.md`
  (line 162), without this file `ctx.auth.getUserIdentity()` always returns
  `null` — i.e. every `requireAccess`/`getUserEmail` call in
  `apps/convex/lib/access.ts` would see the caller as signed out.
- Why `domain` is `process.env.CONVEX_SITE_URL` rather than a hardcoded URL:
  this deployment issues its own tokens (self-issued JWT auth), so the issuer
  is simply this deployment's own site URL, which differs between local dev,
  preview, and prod (`vivid-rhinoceros-688`).

Leave the existing inline `// The local/cloud Convex deployment's site URL is
the JWT issuer.` comment on `domain` as-is — the new block comment is a
module-level companion to it, not a replacement.

Do not change `providers`, `domain`, or `applicationID` — comment-only.

### 2. Add a block comment to `apps/convex/http.ts`

Insert a `/** ... */` block comment as the very first lines of the file,
before `import { httpRouter } from "convex/server";`. It must cover:
- What this file is: the Convex HTTP router — the entire **public,
  unauthenticated-by-default** HTTP surface of the backend (as opposed to the
  `query`/`mutation`/`action` functions elsewhere in `apps/convex/`, which are
  called through the Convex client and gated by `lib/access.ts`).
- What it's for, at a glance — group the routes by purpose rather than
  re-describing each one line by line (the file's own `// ── Section ──`
  comments already do that in detail): auth callback routes
  (`auth.addHttpRoutes`), the JSON APIs backing the public ticketing/
  reimbursement/giving client scripts, the server-rendered public pages
  (`/event/`, `/e/` alias, `/t/`, `/give`, `/p/`, `/reimburse/`), and the two
  webhook receivers (`/stripe/webhook`, `/increase/webhook`).
- What would break without it / why it's load-bearing: this is the
  `export default http` that Convex's HTTP actions router dispatches on —
  removing or misconfiguring it drops every public event page, ticket page,
  giving page, reimbursement page, and both payment-provider webhooks
  (Stripe, Increase) that depend on signature verification happening exactly
  here (`verifyStripeSignature`, `verifyIncreaseSignature`).
- One line noting the `/event/` vs `/e/` dual-prefix and why (already
  explained inline at line 58-61 — the module comment can reference it
  briefly rather than duplicate it).

Do not touch any `http.route(...)` call, any handler body, or any of the
existing `// ── Section ──` inline comments — comment-only, additive at the
top of the file.

### 3. Run validation

Run every command in Validation Commands below. All must exit clean.

## Validation Commands

Execute every command. Every one must exit clean.

- `pnpm typecheck` — `tsc --noEmit` × 3 packages; a comment-only change should
  be a no-op here, but run it to be sure nothing was accidentally broken.
- `pnpm lint` — turbo → 3 packages; expect 0 errors (97 pre-existing warnings
  in `apps/mobile` are known-good, see Notes).
- `pnpm test` — full suite (turbo → 3 packages); zero regressions expected.
- `pnpm build` — web bundle export; expect the 1 real task (`apps/mobile`) to
  succeed.
- `git diff --stat apps/convex/auth.config.ts apps/convex/http.ts` — sanity
  check that only these two files changed.
- `git diff apps/convex/auth.config.ts apps/convex/http.ts | grep -E '^[-+]' | grep -v '^[-+][-+][-+]' | grep -vE '^\+\s*(\*|/\*\*|\*/)|^\+\s*$'` —
  every added/removed line should be part of the new comment block(s); this
  command should print nothing (or only comment-syntax lines) if the change
  is truly comment-only. If it prints a non-comment line, stop and fix before
  proceeding.

## Notes

- **Scope was cut from 8 files to 2** after reading each file in full — see
  the table in "Chore Description". This is not a shortcut; it's the correct
  outcome of the chore's own instruction to add comments only where genuinely
  missing. State this in the PR description.
- **Pre-existing warnings**: `pnpm lint` reports 97 warnings in `apps/mobile`
  (framework advisories, e.g. missing `.web.tsx` counterparts) — these predate
  this chore and are not caused by it; do not attribute them to this change.
- No new dependencies. No schema/migration changes. No renamed exports.
