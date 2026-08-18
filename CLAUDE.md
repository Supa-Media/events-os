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

**A PR you opened is not done until it is MERGED or you have said out loud
that it isn't.** "I'll merge on green" is a commitment that has to be
discharged in the same session. Before ending ANY turn, check every PR you
opened this session and either merge it (green), fix it (red), or state its
exact status in your reply. Never end a turn leaving one silently open —
the user has no reason to suspect a PR you described as finished is still
sitting there, and "I said I'd merge it and then didn't" is the failure
this rule exists to prevent (2026-08-05: #502 sat green and unmerged
because the session moved on after saying it would merge).

**Polling while work is in flight (subagents, CI, deploys): use a
persistent background Monitor ticker. NEVER use `send_later` — for
anything.** It triggers a blocking permission prompt on every call on
claude.ai/code (the repo allowlist is ignored for CCR scheduling tools),
interrupting whoever is at the keyboard. Arm one session-length Monitor
(`while true; do sleep 300; echo "POLL TICK"; done`, persistent) and on
each tick check in-flight branches, CI check runs, and deploy workflows —
never passively wait for completion notifications and never take a
subagent's self-report on faith.

ONE ticker, and on every tick sweep **all** your open PRs — not the one you
armed it for. A ticker mentally bound to a single PR goes stale the moment
that PR merges and a newer one opens behind it, and then nothing is
watching the thing that actually needs watching. Stop the ticker only when
nothing you own is unmerged. For one-shot waits use Bash
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

## Native dependencies and OTA updates

`runtimeVersion` is `{ policy: "appVersion" }` and `version` has been `"1.0.0"`
since the repo was scaffolded, so **every binary and every OTA bundle share the
runtime version `"1.0.0"`** — EAS Update treats them as interchangeable even
when EAS's own native fingerprints differ. That is deliberate: one JS bundle
serving clients on several binaries is what lets an update reach everyone
without forcing a reinstall.

The price is that **a JS bundle can land on a binary that lacks a native module
it imports**, which does not fail gracefully: the bundle fails to load,
expo-updates runs its recovery tasks, exhausts them, and aborts the process.
The crash report names `ErrorRecovery.crash()` and nothing about the module
responsible. TestFlight 1.0.0 (8) died this way on 2026-08-15, 0.4s after
launch, because `react-native-webview` was added five hours after that day's
binary was built and imported statically by three components.

So:

- **`core` is a claim about BINARIES IN THE FIELD, not about `package.json`.**
  It means "every binary we still serve already contains this". A newly added
  native dependency is never `core`, however obviously safe it looks.
- **A new native dependency starts `gated`** in `apps/mobile/native-deps.json`,
  behind a loader in `lib/` that `require()`s it in a try/catch and returns
  `null` when absent (`lib/nativeWebView.ts`, `lib/cameraScanning.ts`). Every
  consumer must render a real fallback for the `null` case — not a blank, and
  for anything load-bearing not merely a notice: the Markdown editor falls back
  to a plain `TextInput`, because "you cannot write the document" is not an
  acceptable degradation.
- **It graduates to `core` only once a binary containing it is the oldest one
  still being served** — i.e. after a native build has shipped and the older
  ones are gone.
- **Never write a gated dependency's name in a static import, a type-only
  import, or even a comment.** `scripts/check-native-imports.js` scans text, so
  all three trip it. Use an inline `typeof import(…)` query for types.
- CI runs that script via the framework's reusable workflow. Note it **skips
  silently** when the file is missing (a `::notice::`, not a failure) — which is
  how this gate no-op'd here for months. Do not delete it.
- Gating covers *additive* native modules. It does not cover a change to an
  existing module's API, an Expo SDK bump, or a native **view** crash (which
  corrupts the Fabric view registry and takes unrelated rendering down with it).
  Those need every client on a new binary, and `runtimeVersion` is the only
  thing that can enforce that — switch to `{ policy: "fingerprint" }` for such a
  release, accepting that old binaries stop receiving updates, which is the
  point.

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

## The Governance Docs Must Track the Product Too

`docs/governance/` holds the org's Bylaws, Operating Manual, and Employee
Handbook — checked in next to the code precisely so the claims they make can
be TESTED. Same standing rule as the Academy, same reason: **every PR that
changes user-facing behavior, vocabulary, money rules, roles/seats, approval
flows, or org process must ask "does the governance library need updating?"**

- Changed a seat, its title, its parent, or its powers (`seats.ts`,
  `powers.ts`)? → the Operating Manual's seat charts and powers table are the
  documented copy of those files. Update them in the same PR.
- Changed a money constant (skim, backer unit, operating floor, tier
  thresholds, receipt grace, purpose minimum, finance timezone)? → the manual
  quotes them and `governance.test.ts` pins them.
- Changed a lifecycle (reimbursements, contractor payments)? → the manual's
  anchored lifecycle blocks must name exactly the real statuses.
- Changed who approves what, or added a separation-of-duties rule? → manual §5,
  and check the Bylaws' delegation articles still cover it.
- Changed what gets published publicly, when, or how corrections work? →
  Bylaws Article XI is a *promise*. Keep it true or amend it.
- Anything touching pay, hours, leave, conduct, safety, or minors at events? →
  Employee Handbook, and flag it for counsel if it's a legal representation
  rather than a practice.

`packages/shared/src/governance.test.ts` fails loudly on structural drift; the
HTML comment anchors in the docs (`<!-- seat-chart:central -->`,
`<!-- money-constants -->`, `<!-- lifecycle:reimbursement -->`, …) mark the
machine-checked regions and must not be removed. It cannot catch a paragraph
that now describes a flow the product no longer has — that judgment is yours.

**Everything in there is a DRAFT until the founder says otherwise.** Do not
flip a `status:` header to ADOPTED, and do not describe these as the org's
operative documents — the 2021 bylaws still are. New governance docs go in the
same directory with the same header block, and get added to `ALL_DOCS` in the
test.
