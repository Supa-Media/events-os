# Feature: Custom-domain public event pages (`events.publicworship.life/event/<slug>`)

## Feature Description
Published event pages are currently served as server-rendered HTML by Convex HTTP
actions at the deployment's built-in domain: `https://<deployment>.convex.site/e/<slug>`.
That URL is unbranded, unmemorable, and leaks the Convex deployment name into every
shared link, OG card, ticket email, and Stripe receipt.

This feature moves the public event page — with zero change to how it's rendered — onto
a branded custom domain and a friendlier path, so a published event lives at:

```
https://events.publicworship.life/event/<slug>
```

The work has two independent halves:

1. **Domain (ops, no code):** front the production Convex deployment's HTTP-action
   endpoint (`*.convex.site`) with the custom domain `events.publicworship.life` via
   Convex's Custom Domains feature + a Namecheap CNAME record, then flip the base-URL
   env vars. Every guest-facing link (`siteUrl()` / `publicSiteUrl()`) already reads
   from these env vars, so **the branded domain lights up with no code change**.

2. **Path (small code change):** rename the public path segment from `/e/` to
   `/event/` across the ~10 places it's hardcoded, behind a single shared helper, while
   keeping `/e/` working as an alias so links already shared in the wild never break.

The value: shareable, trustworthy, on-brand event URLs — the kind you'd put on a flyer,
in a bio, or in an email — instead of a raw Convex subdomain.

## User Story
As an **event lead** publishing an event
I want the **public event page's URL to be `events.publicworship.life/event/<slug>`**
So that **the link I share on socials, flyers, and in emails looks like it belongs to
Public Worship — not a random `*.convex.site` backend address — which people trust and
remember.**

## Problem Statement
The public event page renders correctly but is only reachable at
`https://<deployment>.convex.site/e/<slug>`. That address:
- Exposes the internal Convex deployment name to every guest.
- Looks untrustworthy on a flyer or in a text message ("is this a scam link?").
- Can't be branded, and would break every shared link if the deployment ever changed.

The base-URL helpers (`apps/convex/lib/siteUrl.ts` `siteUrl()`,
`apps/mobile/components/event/ticketing/helpers.ts` `publicSiteUrl()`) were already
built to support a custom domain, but the domain has never been provisioned, and the
path is the terse `/e/` rather than the requested `/event/`.

## Solution Statement
- **Domain:** Add `events.publicworship.life` as an HTTP-Actions custom domain on the
  **production** Convex deployment (`vivid-rhinoceros-688` — the real prod, per
  `reference_convex-prod-deploy-target`). Convex issues a CNAME target and provisions
  the TLS certificate. Add a `CNAME` record `events → <convex-target>` in Namecheap's
  Advanced DNS. Once DNS verifies, set `PUBLIC_SITE_URL=https://events.publicworship.life`
  on the prod deployment (backend) and `EXPO_PUBLIC_SITE_URL=https://events.publicworship.life`
  on the production Expo/EAS build (client). No code changes — the resolvers already read
  these vars, and all links (landing page OG tags, ticket pages, ICS, Stripe return URLs,
  ticket & blast emails, the admin "share" link) recompose off `siteUrl()`/`publicSiteUrl()`.

- **Path:** Introduce one shared constant/helper per package for the public event path
  and route every hardcoded `/e/` through it, then change the value to `/event/`. Add a
  `/e/` alias in the Convex HTTP router (same handler) so already-shared links, cached OG
  image URLs, and previously-sent emails keep resolving. Update the two hardcoded paths in
  `landingPage.ts`, the Stripe return URLs, the two email modules, `blasts.ts`, the seed,
  the admin `TicketingTab` link builder, and the tests.

- **Hygiene:** Reconcile `.env.example`, which documents the var as `SITE_URL` while the
  code reads `PUBLIC_SITE_URL` — a latent footgun.

The domain half delivers the user's core ask on its own; the path half is a cosmetic
polish that can ship in the same PR or immediately after.

## Relevant Files
Use these files to implement the feature:

### Backend (`apps/convex/**`)
- `apps/convex/lib/siteUrl.ts` — `siteUrl()` resolves `PUBLIC_SITE_URL ?? CONVEX_SITE_URL`.
  **Home for the new shared `EVENT_PATH` constant + `eventPageUrl(slug, sub?)` helper.**
- `apps/convex/http.ts:50` — the `pathPrefix: "/e/"` GET route that serves the landing
  page, cover image, and `calendar.ics`. Change prefix to `/event/`; **add a `/e/` alias
  route pointing at the same handler** for backward compatibility.
- `apps/convex/lib/landingPage.ts:110-111` — hardcodes `${siteUrl}/e/${p.slug}` for
  `coverUrl` and `pageUrl` (→ `og:url`, `og:image`); also `:320` (ticket page "Event
  details" link) and `:355` (ICS `URL:`). Route all through the helper.
- `apps/convex/stripe.ts:77,79,157,158` — Stripe checkout `success_url` / `cancel_url`
  built as `${siteUrl()}/e/${args.slug}...`. Route through the helper (preserve query args).
- `apps/convex/ticketingEmails.ts:106,163,189` — ticket-email links to `${siteUrl()}/e/${slug}`.
- `apps/convex/blasts.ts:166` — "View event" button link in blast emails.
- `apps/convex/seedTicketing.ts:8,192` — comment + returned `url: /e/<slug>` for dev seed.
- `apps/convex/ticketing.ts:7,1280` — doc comments referencing `/e/<slug>` (update text).
- `apps/convex/schema/ticketing.ts:7,23,28` — doc comments on the `eventPages` table /
  `slug` / cover referencing `/e/<slug>` (update text only; **no schema change**).
- `apps/convex/tests/landingPage.test.ts:60-61` — asserts `og:url`/cover contain `/e/`.
  Update expectations to `/event/`.

### Client (`apps/mobile/**`)
- `apps/mobile/components/event/ticketing/helpers.ts:15` — `publicSiteUrl()` resolves
  `EXPO_PUBLIC_SITE_URL` → derived Convex URL. **Home for a new `eventPageUrl(slug)` helper.**
- `apps/mobile/components/event/ticketing/TicketingTab.tsx:228` — builds the admin
  "share this link" string as `${publicSiteUrl()}/e/${page.slug}`. Route through the helper.

### Ops / config (no app code)
- `.env.example:4-7` — reconcile the `SITE_URL` mention with the code's `PUBLIC_SITE_URL`.
- Convex Dashboard → prod deployment (`vivid-rhinoceros-688`) → **Settings → Custom Domains**.
- Namecheap → `publicworship.life` → **Advanced DNS** → add CNAME `events`.

### New Files
- `docs/plans/custom-domain-event-pages-runbook.md` *(optional)* — a short ops checklist
  (mirroring `docs/plans/link-migration-runbook.md`'s style) capturing the exact DNS +
  Convex + env-var steps and the rollback, so the domain cutover is repeatable. Can also
  live as a section in this file; create the standalone runbook only if the cutover is
  handed to someone other than the implementer.

## Data Model & API
**No schema change and no new/changed Convex functions.** The public page URL is composed
at read time from `siteUrl()` + path + `slug`; it is never persisted. `getPublicPage`,
`getCoverStorageId`, the ICS/cover sub-routes, and the `eventPages` table are all
untouched in shape. The only backend edits are:
- A new pure helper `eventPageUrl(slug: string, sub?: string): string` (and an
  `EVENT_PATH = "event"` constant) in `apps/convex/lib/siteUrl.ts`.
- The HTTP route `pathPrefix` value in `apps/convex/http.ts` (+ one alias route).
- Doc-comment text updates.

Client side: a mirror helper `eventPageUrl(slug)` in the mobile `helpers.ts`.

## Implementation Plan

### Phase 1: Foundation — shared path helper (no behavior change yet)
Centralize the path so the `/e/` → `/event/` switch is a one-line value change, not a
find-and-replace across 10 files.

- Add to `apps/convex/lib/siteUrl.ts`:
  ```ts
  /** URL path segment for public event pages. Was "e"; kept as "event" for branding. */
  export const EVENT_PATH = "event";

  /** Absolute URL of a public event page (or a sub-resource like "cover"/"calendar.ics"). */
  export function eventPageUrl(slug: string, sub?: string): string {
    const base = `${siteUrl()}/${EVENT_PATH}/${slug}`;
    return sub ? `${base}/${sub}` : base;
  }
  ```
  Note: `landingPage.ts` receives `siteUrl` as a **parameter** (it's a pure renderer), so
  it can't call `siteUrl()` directly — give it a sibling that takes the base explicitly,
  e.g. `export const eventPath = (slug: string, sub?: string) => \`/${EVENT_PATH}/${slug}${sub ? \`/${sub}\` : ""}\``, and have callers do `${siteUrl}${eventPath(p.slug, "cover")}`.
- Add to `apps/mobile/components/event/ticketing/helpers.ts`:
  ```ts
  /** Absolute URL of an event's public page on the branded domain. */
  export function eventPageUrl(slug: string): string {
    return `${publicSiteUrl()}/event/${slug}`;
  }
  ```

### Phase 2: Core Implementation — switch the path to `/event/` and keep `/e/` alive
- In `apps/convex/http.ts`, change the landing-page route `pathPrefix` from `/e/` to
  `/event/`. Extract the handler into a named `httpAction` and register it under **both**
  `/event/` and `/e/` so old links (and OG-cached cover URLs) still resolve. The handler
  already derives `slug`/`sub` from path segments, so it works unchanged under either prefix.
- Replace every hardcoded `${siteUrl}/e/${slug}` / `${siteUrl()}/e/${slug}` with the helper:
  - `apps/convex/lib/landingPage.ts:110,111,320,355`
  - `apps/convex/stripe.ts:77,79,157,158` (keep the `?checkout=success&...` / `?donated=1`
    query suffixes — append them to the helper's return)
  - `apps/convex/ticketingEmails.ts:106,163,189`
  - `apps/convex/blasts.ts:166`
  - `apps/convex/seedTicketing.ts:192`
- Update the mobile admin link: `TicketingTab.tsx:228` → `const link = eventPageUrl(page.slug);`
- Update doc comments referencing `/e/<slug>` in `ticketing.ts`, `schema/ticketing.ts`,
  `seedTicketing.ts`, `landingPage.ts`, `helpers.ts` to `/event/<slug>` (mention the `/e/`
  alias is retained for backward compatibility).
- Update `apps/convex/tests/landingPage.test.ts:60-61` to expect `/event/`.

### Phase 3: Integration — provision the domain and cut over (ops)
No code in this phase. Order matters — DNS + cert must be green **before** flipping env vars.

1. **Convex custom domain (prod):** Dashboard → deployment `vivid-rhinoceros-688` →
   Settings → **Custom Domains** → add `events.publicworship.life` under **HTTP Actions**
   (requires the Convex **Pro** plan — confirm the org is on Pro first). Copy the CNAME
   target Convex displays.
2. **Namecheap DNS:** Advanced DNS for `publicworship.life` → **Add New Record** →
   `CNAME Record`, Host = `events`, Value = the Convex-provided target, TTL = Automatic.
   (Subdomain CNAME — no apex-flattening concern; does not touch existing MX/email records
   for `publicworship.life`.)
3. **Verify:** wait for DNS propagation, confirm Convex shows the domain **Verified** and
   the TLS cert **Active**. Test `https://events.publicworship.life/event/<a-published-slug>`
   returns the landing page HTML with a valid cert.
4. **Backend env:** on prod, `npx convex env set PUBLIC_SITE_URL https://events.publicworship.life`
   (use the `convex-prod` helper / correct deploy target per `reference_convex-prod-deploy-target`).
   This makes OG tags, ICS, ticket/blast emails, and Stripe return URLs all use the branded domain.
5. **Client env:** set `EXPO_PUBLIC_SITE_URL=https://events.publicworship.life` for the
   **production** Expo/EAS build (1Password "Events" vault + EAS env), so the admin "share"
   link and any client-composed URL use the branded domain. Rebuild/redeploy the web app.
6. **Smoke test end-to-end:** publish a test event, copy the share link (should be
   branded), open it, RSVP, add-to-calendar (ICS), and — if tickets are on — run a Stripe
   test checkout and confirm the return URL lands back on `events.publicworship.life`.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Add the shared path helpers (backend + client)
- Add `EVENT_PATH`, `eventPageUrl()`, and the parameter-taking `eventPath()` to
  `apps/convex/lib/siteUrl.ts`.
- Add `eventPageUrl()` to `apps/mobile/components/event/ticketing/helpers.ts`.

### 2. Add a unit test for the helpers
- Extend `apps/convex/tests/siteUrl.test.ts` to assert `eventPageUrl("summer-night")`
  and `eventPageUrl("summer-night", "cover")` produce
  `https://.../event/summer-night` and `.../event/summer-night/cover` under a set
  `PUBLIC_SITE_URL`, and that trailing slashes are trimmed.

### 3. Switch the Convex HTTP route to `/event/` with an `/e/` alias
- In `apps/convex/http.ts`, extract the landing-page handler to a named const and
  register it under both `/event/` and `/e/`. Confirm cover + `calendar.ics` sub-routes
  work under the new prefix.

### 4. Route all backend URL builders through the helper
- Update `landingPage.ts` (110, 111, 320, 355), `stripe.ts` (77, 79, 157, 158 — preserve
  query suffixes), `ticketingEmails.ts` (106, 163, 189), `blasts.ts` (166),
  `seedTicketing.ts` (192).

### 5. Update the mobile admin share link
- `TicketingTab.tsx:228` → `eventPageUrl(page.slug)`.

### 6. Update doc comments and stale tests
- Text updates in `ticketing.ts`, `schema/ticketing.ts`, `seedTicketing.ts`,
  `landingPage.ts`, `helpers.ts`.
- Update `tests/landingPage.test.ts:60-61` to `/event/`.

### 7. Reconcile `.env.example`
- Change the `SITE_URL` mention (line ~5) to `PUBLIC_SITE_URL` and add
  `EXPO_PUBLIC_SITE_URL` with a comment (`e.g. https://events.publicworship.life`,
  optional — falls back to the Convex domain).

### 8. Run all validation commands (see below) — everything must exit clean.

### 9. Provision the domain (ops — Phase 3 checklist)
- Execute the Phase 3 steps: Convex Custom Domain → Namecheap CNAME → verify TLS →
  set `PUBLIC_SITE_URL` (prod backend) and `EXPO_PUBLIC_SITE_URL` (prod client) → smoke test.
  *(This step runs against production and requires the user's Namecheap access + Convex
  Pro; it's the only step that isn't pure code. Do it last, after the code PR is merged.)*

## Testing Strategy

### Unit Tests
- `apps/convex/tests/siteUrl.test.ts` — new cases for `eventPageUrl()` (base + sub-resource,
  trailing-slash trimming, env-var precedence already covered for `siteUrl()`).
- `apps/convex/tests/landingPage.test.ts` — updated `og:url` (`/event/<slug>`) and
  `og:image` (`/event/<slug>/cover`) assertions; add an assertion that the emitted
  `pageUrl` uses the `/event/` segment.

### Integration Tests
- `convex-test` against `http.ts`: a request to `/event/<published-slug>` returns 200 HTML
  containing the event name; `/event/<slug>/cover` returns the image bytes;
  `/event/<slug>/calendar.ics` returns `text/calendar`. **Plus** the same three under the
  legacy `/e/` prefix still return 200 (alias not dropped). `/event/<unpublished-slug>`
  and `/event/<garbage>` return 404.

### Edge Cases
- **Backward compatibility:** already-shared `/e/<slug>` links and OG-cached
  `/e/<slug>/cover` image URLs still resolve (alias route). Ticket emails already delivered
  with `/e/` links still work.
- **Env unset:** with neither `PUBLIC_SITE_URL` nor `EXPO_PUBLIC_SITE_URL` set (local dev),
  URLs fall back to the `*.convex.site` / local backend domain — pages still render.
- **Slug with special chars / spaces:** `slugify` already normalizes; confirm the helper
  doesn't double-encode.
- **Stripe return URLs:** the `?checkout=success&session_id=...`, `?checkout=canceled`,
  `?donated=1` query params survive the helper refactor.
- **Trailing slash:** `PUBLIC_SITE_URL=https://events.publicworship.life/` (with slash) is
  trimmed by `siteUrl()` — no `//event/`.
- **Cert not yet issued:** if env vars are flipped before Convex's cert is Active, the
  branded links 5xx — Phase 3 ordering (verify cert *before* setting env) prevents this.

## Acceptance Criteria
- A published event's public page loads at `https://events.publicworship.life/event/<slug>`
  with a valid TLS certificate.
- The admin "share" link in `TicketingTab` shows the branded `/event/` URL.
- OG/Twitter tags, the `og:image` cover URL, the ICS `URL:` field, ticket & blast email
  links, and Stripe checkout return URLs all use `https://events.publicworship.life/event/...`.
- Legacy `https://<deployment>.convex.site/e/<slug>` links (and their `/cover` images)
  still resolve — no broken previously-shared link.
- No schema change; `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass.
- `.env.example` documents `PUBLIC_SITE_URL` (and `EXPO_PUBLIC_SITE_URL`) matching what the
  code actually reads.

## Validation Commands
Execute every command to validate the feature works with zero regressions. Every command
must exit clean.

- `pnpm typecheck` — typecheck all workspaces (turbo)
- `pnpm lint` — lint all workspaces (turbo)
- `pnpm test` — run all test suites (Convex vitest + mobile jest, via turbo)
- `cd apps/convex && pnpm test` — backend tests only (siteUrl + landingPage + http route tests)
- Manual (local): run `pnpm dev`, seed ticketing (`npx convex run seedTicketing:...`), open
  the local http endpoint at `/event/<slug>` and confirm the page renders; confirm `/e/<slug>`
  still renders (alias).
- Manual (post-cutover, prod): `curl -sI https://events.publicworship.life/event/<published-slug>`
  returns `200` + `content-type: text/html` with a valid cert; publish a test event in the
  app and confirm the share link is branded and opens.

## Notes
- **No new dependencies.** Pure config + a small refactor.
- **Convex Pro required:** HTTP-Actions custom domains are a paid Convex feature — confirm
  the org's plan before Phase 3. If Pro isn't available, the code (path rename + helper)
  still ships and the domain step waits.
- **Production target:** the custom domain and `PUBLIC_SITE_URL` go on the **real prod**
  deployment `vivid-rhinoceros-688` (Supa Media), not the default deploy target — see
  memory `reference_convex-prod-deploy-target`; use the `convex-prod` helper.
- **DNS:** a single `CNAME` on the `events` subdomain. It does not affect existing
  `publicworship.life` email/MX or the auth `ALLOWED_DOMAIN` (that's login-email validation,
  unrelated to page hosting).
- **Upstream-first:** the base-URL resolvers (`siteUrl.ts`, `helpers.ts`) are app-local, not
  `@supa-media/*` framework code, so this change stays in this repo. If the Supa framework
  ever grows a shared "public site URL / custom domain" convention, revisit whether these
  helpers should move upstream.
- **Rollback:** to revert the domain, unset `PUBLIC_SITE_URL` / `EXPO_PUBLIC_SITE_URL` (links
  fall back to `*.convex.site`) and remove the Convex custom domain + Namecheap CNAME. The
  `/e/` alias means no shared link breaks during or after rollback.
- **Future extension:** consider a per-chapter subdomain or vanity path once chapter cloning
  (V3) lands; the `eventPageUrl()` helper is the single seam where that logic would go.
```
