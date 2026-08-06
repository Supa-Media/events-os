# Bug: Door access grant email has no link into guest sign-in

## Bug Description
When an organizer grants a volunteer per-event door access
(`doorAccess.grant`), the notification email tells them how to sign in but
gives them nothing to tap: "Open the app, choose **Sign in as a guest**, and
enter this email address (…)." There is no button, no link, nothing
clickable — the volunteer has to find the app themselves, land on the
member-username screen (the login screen's default), notice and tap "Not a
member? Sign in as a guest," and then retype the exact email the message
already told them.

Expected: the email includes a button/link that opens the app **already in
guest sign-in mode**, ideally with the email address pre-filled, so the
volunteer just requests the code.

Actual: plain instructional text, no link at all.

## Problem Statement
`sendDoorGrantEmail` (`apps/convex/doorAccess.ts`) never renders a CTA link.
Even if it did, today's login screen (`apps/mobile/app/(auth)/login.tsx`)
has no way to be opened directly into guest mode — `useEmailOtpLogin`
always starts in `mode: "member"` — so a bare link to `/login` would still
dump a first-time volunteer on the wrong screen.

## Solution Statement
Two changes, both required for "takes the user directly to guest sign in"
to actually be true:

1. **Give the login screen a deep-link entry point into guest mode.** Add a
   `?guestEmail=<email>` query param to `apps/mobile/app/(auth)/login.tsx`:
   when present, `useEmailOtpLogin` starts in `mode: "guest"` with the field
   pre-filled to that email, instead of the default member/username screen.
   This follows the exact precedent already in this file for `?redirect=`
   (read via `useLocalSearchParams`, threaded into the screen's state) and in
   `(app)/_layout.tsx`'s `currentDestination`/`Redirect` round-trip.
2. **Point the email's CTA at that entry point.** Add a `guestSignInUrl(email)`
   helper next to `appUrl()` in `apps/convex/lib/siteUrl.ts`, and use it in
   `sendDoorGrantEmail` to render a real `emailButton` (the same primitive
   `ticketingEmails.ts#sendRsvpEmail` uses for its single CTA), falling back
   to the existing plain-text instructions when `APP_URL` is unset — mirroring
   `cards.ts#notifyPersonalChargeFlagged`'s documented "degrade LOUDLY,
   never silently ship a CTA-less email" pattern (`console.error` + a
   still-actionable text fallback).

**Why fix `accessAllowlist.ts#sendAccessGrantedEmail` in the same PR:**
`doorAccess.ts`'s own module comment says `sendDoorGrantEmail` "Mirrors
`accessAllowlist.sendAccessGrantedEmail`'s shell + guest-sign-in copy" — the
two functions are near-identical strings, deliberately kept in sync. Leaving
one with a working CTA and the other still card-less copy would break that
documented mirror and immediately look like a second, unfixed instance of
the exact same bug on the very next grant a superuser makes. Same root
cause, same fix, same two files' pattern already extending it (§ Sweep
below) — this is not a scope expansion, it's the other half of one mirrored
pair.

**Why not just link to `/login`:** that lands a first-time volunteer, who
has never opened the app, on the *member* username screen — they'd still
have to notice and tap "Sign in as a guest," then retype the email the
message already gave them. That is a materially incomplete fix for a bug
titled "should take the user directly to guest sign in."

## Steps to Reproduce
1. As a chapter member, open an event → **Door access** → grant a volunteer's
   email.
2. Read the resulting email (`sendDoorGrantEmail`'s output — reproduced
   directly by reading the template in `apps/convex/doorAccess.ts:222-236`,
   since it renders identical HTML for every recipient).
3. Observe: the email contains two `<p>` paragraphs of instructions and no
   `<a href>` anywhere.

This was confirmed by reading the email template and its call site rather
than sending a live email — the template is pure (same input, same output),
so reading it is equivalent to reproducing the send.

## Root Cause Analysis
**File/line:** `apps/convex/doorAccess.ts:222-236` (`sendDoorGrantEmail`) —
the `emailShell(...)` call only composes `emailHeading` + `emailParagraph`
fragments; no `emailButton` (or any `<a>`) is ever built. The one `import`
line at the top of the file (`emailHeading, emailParagraph, emailShell` from
`./lib/emailShell`) confirms `emailButton` isn't even in scope.

Compounding cause: `apps/mobile/app/(auth)/useEmailOtpLogin.ts:26-27` always
initializes `mode` to `"member"` and `guestEmail` to `""`, and
`apps/mobile/app/(auth)/login.tsx` reads only `?redirect=` from
`useLocalSearchParams` — there is no query param that can steer the screen
into guest mode. So a `/login` link alone could not satisfy "takes the user
directly to guest sign in" even if added.

**Confidence:** high — both files were read directly; the missing behavior
is a straightforward absence (no button-building call, no guest-mode query
param), not a subtle runtime interaction.

**Why this is the root, not a symptom:** patching only the crash-site-shaped
fix ("just add `emailButton(appUrl('/login'), 'Sign in')`") would still
leave a volunteer on the wrong screen after tapping it — the login screen's
mode defaults would still win. Fixing the login screen's deep-link contract
is what makes the email's link actually resolve to "already in guest sign-in,"
which is the behavior asked for. This also explains why
`accessAllowlist.ts#sendAccessGrantedEmail` — the general guest-grant email,
documented as this file's mirror — has the identical gap: the same missing
`emailButton` call, the same missing login deep-link target.

## The Failing Test
- **File:** `apps/convex/tests/doorAccess.test.ts` (existing file — add a new
  `describe` block; this file's imports/helpers already cover `doorAccess.ts`)
  and `apps/mobile/app/(auth)/login.helpers.test.ts` (**new file** — no test
  currently covers `login.helpers.ts`; mobile tests are logic-only, colocated
  `.test.ts` files per `apps/mobile/components/event/newEventValidation.test.ts`
  — there is no rendering-level test harness in this repo for hooks/screens,
  so the guest-mode-from-query-param logic must live in a pure, testable
  helper rather than be asserted by rendering `login.tsx`).
- **Follows the pattern in:**
  - Backend: `apps/convex/tests/personalExpenseFlow.test.ts`'s
    `describe("notifyPersonalChargeFlagged — the pay-back link", ...)` block
    (`apps/convex/tests/personalExpenseFlow.test.ts:699-782`) — the exact
    "APP_URL set → real clickable link" / "APP_URL unset → no dead link,
    logs `console.error`" pair to mirror, including its `globalThis.fetch`
    mock and `process.env.APP_URL`/`RESEND_API_KEY` save/restore-in-`finally`
    shape. Also reuse `setupChapter`, `run`, `seedEvent` (local helper already
    in `doorAccess.test.ts`) for the fixture.
  - Mobile: `apps/mobile/components/event/newEventValidation.test.ts` — plain
    `describe`/`test` over a pure exported function, `@jest/globals` import.
- **Bug kind:** Rendering / output (the email's HTML must contain a specific
  clickable CTA) + a pure state-derivation unit (query param → initial mode).
- **Name (backend):** `describe("sendDoorGrantEmail — the guest sign-in
  link")` with tests `"with APP_URL set, the email's button links straight
  into guest sign-in, pre-filled with the volunteer's email"` and `"with
  APP_URL unset, the email still sends (no dead link) and degrades LOUDLY via
  console.error"`.
- **Name (mobile):** `describe("initialGuestState")` with tests covering a
  present `guestEmail` param (→ `mode: "guest"`, email carried through) and
  an absent/empty one (→ unchanged `mode: "member"` default).
- **Asserts:**
  - Backend, APP_URL set: `sent[0].html` matches
    `/<a[^>]*href="https:\/\/app\.publicworship\.life\/login\?guestEmail=vol%40example\.com"[^>]*>/`
    (exact URL, not just "contains a link") — the same attribute-order-
    agnostic regex shape `personalExpenseFlow.test.ts` uses.
  - Backend, APP_URL unset: `sent[0].html` still sent (`toHaveLength(1)`),
    contains **no** `<a href` anywhere, still contains the plain-text
    fallback instructions, and `console.error` was called with a message
    including `"APP_URL is unset"`.
  - Mobile: `initialGuestState("vol@example.com")` returns
    `{ mode: "guest", guestEmail: "vol@example.com" }` exactly;
    `initialGuestState(undefined)` and `initialGuestState("")` both return
    `{ mode: "member", guestEmail: "" }` exactly.
- **Expected failure before the fix:**
  - Backend APP_URL-set test: `expect(sent[0].html).toMatch(...)` fails
    because `sent[0].html` contains no `<a` element at all (regex has zero
    matches).
  - Mobile test: `initialGuestState` fails to import — the function does not
    exist yet in `login.helpers.ts` (module resolution / TypeScript error,
    not a runtime assertion — expected, since this is establishing a new
    export; once it exists the meaningful assertion is the returned shape).

Two tests because root cause and symptom live in different modules/layers:
the backend unit test pins the email's link target (root of the "no CTA"
half), and the mobile unit test pins the login screen's deep-link contract
(root of the "wrong screen" half) that the backend link depends on.

## Relevant Files
Use these files to fix the bug:

- `apps/convex/doorAccess.ts` — `sendDoorGrantEmail`: add the `emailButton`
  CTA, wired to the new `guestSignInUrl` helper, with the degrade-loudly
  fallback.
- `apps/convex/accessAllowlist.ts` — `sendAccessGrantedEmail`: same fix,
  mirrored (see Solution Statement for why it's in scope).
- `apps/convex/lib/siteUrl.ts` — add `guestSignInUrl(email)` next to the
  existing `appUrl()`, reusing it rather than duplicating the `APP_URL`
  env read.
- `apps/convex/lib/emailShell.ts` — `emailButton` (already exists, no
  change) — the primitive both email fixes use.
- `apps/convex/ticketingEmails.ts` — `sendRsvpEmail` (~line 162) — the
  precedent for a single-CTA transactional email using `emailButton`.
- `apps/convex/cards.ts` — `notifyPersonalChargeFlagged` (~line 2895-2932)
  — the precedent for the "degrade LOUDLY when `APP_URL` unset" shape
  (`console.error` + always-actionable fallback text) to copy exactly.
- `apps/mobile/app/(auth)/login.tsx` — read `guestEmail` from
  `useLocalSearchParams` alongside the existing `redirect`, pass the derived
  initial state into `useEmailOtpLogin`.
- `apps/mobile/app/(auth)/login.helpers.ts` — add the new pure
  `initialGuestState` helper; existing `Mode` type reused.
- `apps/mobile/app/(auth)/useEmailOtpLogin.ts` — accept an initial
  `{ mode, guestEmail }` argument (defaulting to today's `member`/`""`) so
  the screen can seed guest mode instead of hardcoding `useState("member")`.
- `apps/convex/tests/doorAccess.test.ts` — add the new `describe` block;
  reuse its existing `seedEvent` helper and `newT`/`run`/`setupChapter`
  imports.
- `apps/convex/tests/personalExpenseFlow.test.ts` — read-only reference for
  the exact test shape to mirror (see above).

### New Files
- `apps/mobile/app/(auth)/login.helpers.test.ts` — unit tests for
  `initialGuestState`.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Capture the baseline
- Baseline already captured during planning: `pnpm turbo run test` → **5/5
  tasks successful, 3930/3930 backend tests passed, zero failures.** Re-run
  it before starting to confirm nothing has drifted, and cross-check any
  new failure against this "none" baseline before attributing it to your
  own change.

### 2. Write the failing tests (RED)
- Add `describe("sendDoorGrantEmail — the guest sign-in link", ...)` to
  `apps/convex/tests/doorAccess.test.ts` with the two tests described above
  (mirror `personalExpenseFlow.test.ts:699-782`'s fetch-mock +
  env-var-save/restore shape; invoke via
  `t.action(internal.doorAccess.sendDoorGrantEmail, { email, eventName })`
  directly — no need to go through the `grant` mutation/scheduler for this
  unit test).
- Add `apps/mobile/app/(auth)/login.helpers.test.ts` with
  `describe("initialGuestState", ...)` and the two cases above.
- Run both. Expected RED:
  - `pnpm --filter @events-os/convex exec vitest run tests/doorAccess.test.ts`
    → the APP_URL-set assertion fails because `sent[0].html` has no `<a`
    element (regex `toMatch` fails with zero matches) — a genuine failure
    matching the diagnosis. The APP_URL-unset test should already PASS
    (there's no `<a>` and no button today either) — that's expected and
    fine, it's guarding against a regression the fix could introduce.
  - `pnpm --filter @events-os/mobile test -- login.helpers` (or the repo's
    equivalent Jest invocation for this workspace) → fails to resolve
    `initialGuestState` from `./login.helpers` (import/type error) — expected
    per "Expected failure before the fix" above; this is establishing a new
    export, not a regression signal, so proceed once you've confirmed it's
    exactly this missing-export error and nothing else.
- Record the actual failure output.

### 3. Add `guestSignInUrl` to `lib/siteUrl.ts`
- Add, right after `appUrl`:
  ```ts
  /**
   * Deep link straight into GUEST sign-in, pre-filled with `email` — what a
   * "you've been granted access" email's CTA should point at, instead of a
   * bare appUrl("/login") (which lands a first-time visitor on the MEMBER
   * username screen and makes them find + retype the email themselves).
   * Null when APP_URL is unset, per appUrl's contract — callers must degrade
   * the same way appUrl's other callers do (see cards.ts#notifyPersonalChargeFlagged).
   */
  export function guestSignInUrl(email: string): string | null {
    const base = appUrl("/login");
    return base ? `${base}?guestEmail=${encodeURIComponent(email)}` : null;
  }
  ```

### 4. Wire the CTA into `sendDoorGrantEmail`
- In `apps/convex/doorAccess.ts`:
  - Import `emailButton` from `./lib/emailShell` and `guestSignInUrl` from
    `./lib/siteUrl`.
  - Inside the handler, before building `html`, compute the link and degrade
    loudly exactly like `cards.ts#notifyPersonalChargeFlagged`:
    ```ts
    const link = guestSignInUrl(email);
    if (!link) {
      console.error(
        "[doorAccess] sendDoorGrantEmail: APP_URL is unset — sending WITHOUT a guest-sign-in link",
        email,
      );
    }
    ```
  - Replace the second `emailParagraph` (the "Open the app, choose Sign in
    as a guest…" instructions) with a link-aware version: when `link` is
    present, shorten the paragraph to the context sentence and add
    `emailButton(link, "Sign in as a guest")` beneath it; when absent, keep
    today's full plain-text instructions unchanged (the existing fallback
    text is already actionable — reuse it verbatim rather than inventing new
    copy).

### 5. Mirror the fix in `accessAllowlist.ts#sendAccessGrantedEmail`
- Same shape: import `emailButton` (add to the existing `emailShell` import
  line) and `guestSignInUrl` (add an import from `./lib/siteUrl`), compute
  `link`/degrade-loudly the same way, swap the second paragraph for the
  button when `link` is present.

### 6. Add guest-mode deep-link entry point to the login screen
- `apps/mobile/app/(auth)/login.helpers.ts`: add
  ```ts
  /** Derives the login screen's initial mode/email from a `?guestEmail=`
   *  deep link (what `guestSignInUrl` in the backend composes). A present,
   *  non-empty value means "arrive already in guest mode, pre-filled" —
   *  absent/empty preserves today's default (member mode, blank fields). */
  export function initialGuestState(
    guestEmailParam: string | undefined,
  ): { mode: Mode; guestEmail: string } {
    const email = guestEmailParam?.trim() ?? "";
    return email ? { mode: "guest", guestEmail: email } : { mode: "member", guestEmail: "" };
  }
  ```
- `apps/mobile/app/(auth)/useEmailOtpLogin.ts`: accept an optional initial
  state argument, defaulting to today's behavior:
  ```ts
  export function useEmailOtpLogin(
    initial: { mode: Mode; guestEmail: string } = { mode: "member", guestEmail: "" },
  ) {
    ...
    const [mode, setMode] = useState<Mode>(initial.mode);
    ...
    const [guestEmail, setGuestEmail] = useState(initial.guestEmail);
    ...
  ```
  (only the two `useState` initializers change — everything else in the hook
  is untouched).
- `apps/mobile/app/(auth)/login.tsx`: read the new param alongside the
  existing one and thread it through:
  ```ts
  const { redirect, guestEmail } = useLocalSearchParams<{
    redirect?: string;
    guestEmail?: string;
  }>();
  const login = useEmailOtpLogin(initialGuestState(guestEmail));
  ```
  (import `initialGuestState` from `./login.helpers`).

### 7. Prove the tests guard the fix (PROVE)
- Temporarily revert steps 3-6 (or just step 4's `emailButton` call and
  step 6's `useState` initializer changes — the two halves each test
  pins) and re-run both new tests.
  - Backend APP_URL-set test → fails again (no `<a href>` in the output).
  - Mobile test → fails again (`initialGuestState` doesn't exist / doesn't
    return `mode: "guest"`).
- Restore the fix; confirm both pass green. Never leave this step reverted.

### 8. Sweep for siblings (SWEEP)
- `grep -rn "Open the app, choose" apps/convex` — this is the exact phrase
  shared by both fixed emails; confirm no third call site still carries the
  unlinked copy. (Expected: only the two already fixed in steps 4-5 match,
  post-fix with the new button copy — if a third module has independently
  duplicated this string, do NOT fix it silently; report it as a follow-up.)
- `grep -rn "appUrl(\"/login\"\|appUrl('/login'" apps/convex` — confirm
  `guestSignInUrl` is the only caller composing a `/login` link (no second,
  inconsistent hand-built version elsewhere).

### 9. Run the Validation Commands
- Every command below. Zero new regressions against the recorded baseline
  (3930/3930 backend tests, 5/5 turbo tasks, all green).

## Validation Commands
Execute every command to validate the bug is fixed with zero regressions.

- `pnpm --filter @events-os/convex exec vitest run tests/doorAccess.test.ts`
  — fails before the fix (the new `describe` block), passes after
- `pnpm --filter @events-os/convex test` — full backend suite, zero
  regressions (was 3930/3930 passing)
- `pnpm --filter @events-os/convex typecheck` — backend typecheck
- `pnpm --filter @events-os/mobile` test command covering
  `login.helpers.test.ts` (Jest; use this repo's actual mobile test script,
  e.g. `pnpm --filter @events-os/mobile test`) — fails before the fix
  (missing export), passes after
- `pnpm turbo run test` — full suite, zero regressions
- `pnpm turbo run build` — nothing here changes a build-time contract, but
  run it per the harness default validation commands

## Regression Risk
- **`accessAllowlist.ts#sendAccessGrantedEmail`** is also used for the
  general (non-door) superuser guest grant — verify its existing callers/
  tests (if any exercise this action) still pass; the change is additive
  (a button replaces/sits beside existing text) so the email still contains
  the same information either way.
- **`useEmailOtpLogin`'s new parameter** changes its public signature (was
  zero-arg). Grep `apps/mobile` for every call site (`login.tsx` is very
  likely the only one — this is a route-scoped hook) before assuming it's
  safe; the default argument value keeps every other call site's behavior
  byte-for-byte identical if one is found.
- **`guestSignInUrl`/`appUrl("/login")`** assumes the login screen is
  reachable at the bare `/login` path on the deployed Expo web build (no
  `(auth)` group prefix) — consistent with every other `appUrl(...)` call
  site in the repo (`/finances`, `/campaign/:id`, `/project/:id`, `/team/:id`,
  none of which include a route-group segment). A reviewer should confirm
  this against `docs/plans/url-consolidation.md`'s routing table rather than
  assume `/(auth)/login` (the internal-navigation form used by `Redirect
  href` inside the app, which is a different concern from the external URL
  a static export serves).
- **Encoding:** `encodeURIComponent(email)` in `guestSignInUrl` must
  round-trip correctly through `useLocalSearchParams` — Expo Router decodes
  query params automatically, so `initialGuestState` should receive the
  plain email, not a doubly-encoded string; the "APP_URL set" test's exact
  URL assertion (`guestEmail=vol%40example.com`) both documents and pins
  this.

## Notes
**Pre-existing failures** (recorded at planning time): none — `pnpm turbo
run test` ran fully green: 5/5 tasks successful, 3930/3930 backend tests
passed, in 29.8s.

No new dependencies. Nothing deliberately left unfixed: the plan covers
both the door-grant email (the reported bug) and its documented mirror (the
general guest-grant email) so the two stay in sync, per `doorAccess.ts`'s
own "Mirrors `accessAllowlist.sendAccessGrantedEmail`" comment — leaving one
fixed and one not would be a known, self-documented inconsistency shipped on
purpose.
