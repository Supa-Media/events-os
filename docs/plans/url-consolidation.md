# URL consolidation: one domain, `https://publicworship.life`

## Status

Shipped (code). This is the canonical doc for the URL architecture — supersedes
[docs/plans/custom-domain-event-pages.md](./custom-domain-event-pages.md), which
proposed `events.publicworship.life` (later provisioned as
`rsvp.publicworship.life`). Both subdomains are retired in favor of path-based
routing on a single apex domain.

## Why

The app was split across three domains:

- `publicworship.life` — static landing (formerly the `lilseyi/public-worship`
  repo on GitHub Pages, now `apps/landing` here).
- `events.publicworship.life` — the Expo web app (authenticated "OS"), on EAS
  Hosting at `events-os.expo.app`.
- `rsvp.publicworship.life` — Convex HTTP actions serving public event / RSVP /
  give / reimburse pages, at `vivid-rhinoceros-688.convex.site`.

Three domains means three TLS certs, three places a link can 404, and a
confusing story for anyone sharing a link ("wait, which subdomain is that
on?"). Consolidating onto one domain with path-based routing fixes that: one
thing to remember, one thing to secure, one place to look when something's
broken.

## Architecture

A **Cloudflare Worker** fronts the apex `https://publicworship.life` and
routes by path prefix:

```
https://publicworship.life
├── /os/*                                   → Expo web app (prefix stripped)
│                                              origin: events-os.expo.app
├── /event, /e, /t, /give, /p, /reimburse,
│   /api, /stripe, /increase                → Convex HTTP actions
│                                              origin: <deployment>.convex.site
└── everything else                         → static landing
                                               (apps/landing, Worker assets)
```

Legacy subdomains 301-redirect to the new paths:

- `events.publicworship.life/*` → `https://publicworship.life/os/*`
- `rsvp.publicworship.life/*` → `https://publicworship.life/*`

### The three origins

| Origin | What it serves | Owned by |
|---|---|---|
| `events-os.expo.app` (EAS Hosting) | The Expo web export — the authenticated app | `apps/mobile` |
| `<prod-deployment>.convex.site` (Convex HTTP actions) | Public event/ticket/give/reimburse pages, Stripe/Increase webhooks, the `/api/*` JSON endpoints those pages call | `apps/convex` |
| Worker static assets (`apps/landing/dist`, bundled with pw-router) | Static marketing/landing pages | `apps/landing` |

### Final URL map

| Path on `publicworship.life` | Routed to | Notes |
|---|---|---|
| `/` and other landing paths (e.g. `/about`, marketing pages) | Landing | Default/fallback route — anything not matching a reserved prefix below |
| `/os/*` | Expo web app | Prefix stripped before proxying; this is where the authenticated app lives |
| `/event/<slug>`, `/event/<slug>/cover`, `/event/<slug>/calendar.ics` | Convex | Public event landing page + sub-resources |
| `/e/<slug>` | Convex | Legacy alias for `/event/<slug>` (kept alive server-side, see `apps/convex/http.ts`) |
| `/t/<code>` | Convex | Public ticket page |
| `/give`, `/give/<slug>` | Convex | Public giving map / territory campaign page |
| `/p/<token>` | Convex | Project email-action landing page (reminder-email links) |
| `/reimburse/<chapterSlug>` | Convex | Accountless reimbursement claimant form/status page |
| `/api/*` | Convex | JSON endpoints the above pages' client scripts call (`/api/tickets/*`, `/api/give/*`, `/api/reimburse/*`) |
| `/stripe/webhook` | Convex | Stripe webhook receiver |
| `/increase/webhook` | Convex | Increase webhook receiver (services both prod and sandbox) |

Routes nested *under* `/os` (e.g. `/os/share/<eventId>`, `/os/songs/<eventId>`,
`/os/d/<shareId>`, `/os/reimburse-request`) are pages within the Expo app
itself — they don't need their own top-level reservation, they just ride
along with `/os/*`.

### Reserved top-level prefixes

Future landing pages (`apps/landing`) must **not** claim any of these — they're
routed to Convex or the Expo app, not the landing origin:

```
/os
/event
/e
/t
/give
/p
/reimburse
/api
/stripe
/increase
```

Everything else (e.g. `/songs`, `/pricing`, `/blog`, `/about`) is fair game for
landing — `/songs` in particular is safe because the app's song-request page
lives at `/os/songs/<id>`, under the reserved `/os` prefix, not at a bare
top-level `/songs`.

## Env vars

| Var | Where it's set | Controls | Prod value |
|---|---|---|---|
| `PUBLIC_SITE_URL` | Convex deployment (`convex env set`) | Base URL for guest-facing links the **backend** composes: landing pages, OG tags, ICS, Stripe return URLs, ticket/blast emails (`apps/convex/lib/siteUrl.ts`) | `https://publicworship.life` |
| `EXPO_PUBLIC_SITE_URL` | Expo/EAS build env | Base URL for guest-facing links the **client** composes (admin "share this link" URLs) (`apps/mobile/components/event/ticketing/helpers.ts`) | `https://publicworship.life` |
| `APP_URL` | Convex deployment (`convex env set`) | Deep link **from** guest-facing backend pages/emails **into** the authenticated app (`apps/convex/lib/siteUrl.ts`'s `appUrl()`) | `https://publicworship.life/os` |
| `CONVEX_SITE_URL` | Set automatically by Convex | Auth issuer + fallback base URL when `PUBLIC_SITE_URL` is unset. **Untouched by this consolidation** — it's the deployment's own `*.convex.site` domain, unrelated to the public-facing branding | (unchanged) |

`apps/mobile/app.config.js` also sets `experiments.baseUrl = "/os"`, mirrored
as `APP_BASE_PATH` in `apps/mobile/lib/appUrl.ts` — this is what lets
expo-router's own routing (and the `webAppUrl()` helper for hand-built
absolute URLs) resolve correctly under the `/os` prefix. The two must be kept
in sync by hand (`app.config.js` is plain CommonJS, not run through the
TS/Babel pipeline, so it can't `import` the constant).

## Redirect rules (legacy subdomains)

- `https://events.publicworship.life/<path>` → `301` → `https://publicworship.life/os/<path>`
- `https://rsvp.publicworship.life/<path>` → `301` → `https://publicworship.life/<path>`

Both are permanent redirects — no code on either side depends on the old
subdomains resolving directly once the Worker is live; they exist purely so
already-shared links (tickets, emails, social posts, printed QR codes) don't
break.

## Ops runbook

### Cutover checklist (one-time, in order)

Prereq: a Cloudflare account. Do steps 1–2 first; they're zero-downtime (the
site keeps serving from GitHub Pages until step 5).

1. **Cloudflare — add the zone.** Dashboard → Add a domain →
   `publicworship.life` (Free plan). Cloudflare scans and imports the existing
   DNS records from Namecheap. **Before continuing, verify the import captured
   every record** — especially MX and TXT (SPF/DKIM/DMARC) for
   `hello@`/`give@` email, and note down the current A records for the apex
   (GitHub Pages: `185.199.108–111.153`) and the CNAMEs for `www`
   (`lilseyi.github.io`), `events` (`origin.expo.app`), and `rsvp` (the
   `*.convex.domains` target) — they're the rollback path.
2. **Namecheap — switch nameservers.** Domain List → `publicworship.life` →
   Nameservers → Custom DNS → enter the two nameservers Cloudflare shows for
   the zone. Wait for Cloudflare to report the zone Active (minutes to a few
   hours). Nothing user-visible changes yet — the imported records still point
   at the old hosts.
3. **Cloudflare — API token for CI.** My Profile → API Tokens → Create Token →
   "Edit Cloudflare Workers" template, scoped to this account (and the zone).
   Also copy the Account ID (zone Overview page, right column).
4. **GitHub — secrets.** In `Supa-Media/events-os` → Settings → Environments →
   `production` (same environment the other deploy secrets live in): add
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. **Merge + deploy.** Merge the consolidation PR (or ask Claude to). The
   `Deploy Landing (production)` workflow builds `apps/landing` and runs
   `wrangler deploy` for `pw-router`. Then, without dawdling (see the note
   below): Workers & Pages → `pw-router` → Settings → Domains & Routes → add
   **Custom Domains** for `publicworship.life`, `www.publicworship.life`,
   `events.publicworship.life`, `rsvp.publicworship.life` (Cloudflare will
   offer to replace the existing DNS records for each — accept).
6. **Convex — prod env vars.** From a checkout:
   `npx convex env set PUBLIC_SITE_URL https://publicworship.life --prod` and
   `npx convex env set APP_URL https://publicworship.life/os --prod`. Also
   rename/create the matching 1Password items (`PUBLIC_SITE_URL`, `APP_URL`)
   in the vault so `sync-secrets.yml` doesn't drift (its allowlist was updated
   in this PR).
7. **Verify** with the post-cutover checklist below, then **clean up**: remove
   the `events.publicworship.life` custom domain in the EAS Hosting dashboard
   and the `rsvp.publicworship.life` custom domain in the Convex dashboard
   (both are dead DNS-wise once step 5 lands; removing avoids stale-cert
   confusion). Merge the tombstone PR in `lilseyi/public-worship` and archive
   that repo (Settings → Danger Zone → Archive).

**Timing note on step 5:** merging also triggers the regular web deploy, which
publishes the Expo bundle with the `/os` base path to `events-os.expo.app`.
Between that deploy finishing and the custom domains attaching,
`events.publicworship.life` serves an app shell whose asset URLs 404 — a
window of a few minutes. Do step 5's domain-attach immediately after the
workflows go green.

**Rollback:** detach the four custom domains from `pw-router` and re-create
the original DNS records noted in step 1 (apex A records → GitHub Pages,
`www` → `lilseyi.github.io`, `events` → `origin.expo.app`, `rsvp` → the
Convex `*.convex.domains` target), then `convex env set` the two vars back.
The old origins are all still alive until step 7's cleanup, so rollback is
pure DNS.

### Morning checklist (post-cutover)

1. `curl -sI https://publicworship.life/` → expect `200` from the landing origin.
2. `curl -sI https://publicworship.life/os` → expect the Expo app's HTML (not a
   404 from EAS Hosting — confirms the Worker is stripping `/os` before
   proxying).
3. `curl -sI https://publicworship.life/event/<a-known-published-slug>` →
   expect `200` from Convex.
4. `curl -sI https://events.publicworship.life/` → expect a `301` to
   `https://publicworship.life/os`.
5. `curl -sI https://rsvp.publicworship.life/` → expect a `301` to
   `https://publicworship.life/`.
6. Confirm TLS is valid on all of the above (no cert warnings) — `curl -sI`
   fails closed on a bad cert, so a `200`/`301` here already implies a valid
   chain.
7. Spot-check one real user flow end to end: open `/os`, sign in, publish (or
   view) an event, copy its share link, open the link in a private window,
   confirm it renders without needing `/os` or a legacy subdomain.

### Where things live

- **Worker source:** `infra/router/` in this repo (`pw-router`). The routing
  table is code — `infra/router/src/route.ts` — with unit tests next to it.
  To change routing, edit that file and merge; there is no KV/env-var
  indirection.
- **Deploys:** `.github/workflows/deploy-landing.yml` on every merge to `main`
  touching `apps/landing/**` or `infra/router/**` (builds the Astro site,
  bundles it as Worker static assets, `wrangler deploy`). Manual escape hatch:
  `pnpm --filter "./apps/landing" build && cd infra/router && npx wrangler deploy`
  with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` set.
- **Hostnames:** attached to the Worker as Cloudflare **Custom Domains** (all
  four: apex, `www`, `events`, `rsvp`) — dashboard-managed, not in
  `wrangler.jsonc`, because they require the zone to be active on Cloudflare
  DNS first.

## Notes

- **No schema or Convex function changes.** This consolidation is entirely
  URL/env-var/config — every Convex HTTP route already reads its base URL
  from `siteUrl()` (backend) or `publicSiteUrl()` (client), so pointing those
  at the new domain is enough.
- **`/e/` alias stays.** The `/event/` vs `/e/` backward-compat alias
  (`apps/convex/http.ts`) is unrelated to this consolidation and is untouched
  — already-shared `/e/<slug>` links keep resolving under the new domain too.
- **Upstream-first:** the Cloudflare Worker and its routing table are
  app-specific infra, not `@supa-media/*` framework code — this doc and its
  implementation stay in this repo.
