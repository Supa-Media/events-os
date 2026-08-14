# Contractor Payments — Engineering Survey

**Status:** read-only architecture survey. No code was changed.
**Audience:** the engineer implementing contractor agreements + ACH payout.
**Date:** 2026-08-14.

---

## 0. Executive summary — the headline finding

**The feature you are about to build already exists, in a different costume.**

`reimbursements.ts` + the `/reimburse/<chapterSlug>` public page is, structurally, the
contractor-payment feature:

| Contractor payment needs | Reimbursements already has |
|---|---|
| Tokenized public page, no login | `reimbursementRequests.token` (`crypto.randomUUID()`), `by_token` index, `/reimburse/<slug>?token=` |
| Unauthenticated file upload (W9) | `reimbursements.preSubmitUploadUrl` — a **public** mutation returning `ctx.storage.generateUploadUrl()`, chapter-slug scoped, IP rate-limited |
| Unauthenticated bank-detail capture | `reimbursements.linkPublicBankAccount` — a **public** action creating a real Increase External Account. **Raw routing/account numbers never persist in Convex** |
| Approval with separation of duties | `approve` / `preApprove` / `requestChanges` / `reject` + `assertApprovalSoD` |
| ACH out via Increase | `increasePayouts.payReimbursement` → `POST /ach_transfers`, idempotency-keyed |
| Spend on the public ledger | `postReimbursementSpend` writes `flow:"outflow"` txn → coding → `financePublicationEntries` |
| Emails at every state change | `sendReimbursementSubmittedEmail` / `…ApprovedEmail` / `…PaidEmail` / `…ChangesRequestedEmail` |

**Recommendation: build contractor agreements as a sibling table + sibling public page that
reuses `increaseExternalAccounts.createExternalAccount`, `increasePayouts`' payout machine,
and `lib/increasePayoutMachine.ts#postReimbursementSpend`'s shape — not as a fork of
`reimbursements.ts`.**

Two hard gaps (§10): the **payout machine is hard-wired to `reimbursementRequests`** (both
the `payouts` table and `postReimbursementSpend` take an `Id<"reimbursementRequests">`), and
there is **no W9 / 1099 / tax-document concept anywhere in the codebase**.

---

## 1. Tokenized public-link pages

### 1.1 Three distinct patterns exist

| Pattern | Rendering | Example | When to use |
|---|---|---|---|
| **A. Server-rendered HTML from Convex `httpAction`** | `lib/*Page.ts` returns a template-literal HTML string; a `*PageStyles.ts` / inline `const *_CSS` holds the stylesheet; a `const *_SCRIPT` string holds vanilla JS; JSON round-trips through `lib/*ApiRoutes.ts` | `/reimburse/<slug>`, `/give`, `/finances`, `/p/<token>`, `/poll/<token>`, `/unsubscribe/<token>`, `/rsvp/<slug>` | Anything a stranger opens from an email. No JS bundle, no auth, SEO/OG friendly |
| **B. Expo Router route outside the auth group** | React Native / RN-Web screen calling a **public** Convex `query`/`action` directly | `apps/mobile/app/pay/[token].tsx`, `app/d/[shareId]`, `app/reimburse-request.tsx` | When you want the app's component kit and are happy requiring JS |
| **C. Authed in-app screen** | `apps/mobile/app/(app)/…` | `finances/reimbursements/index.tsx` | Staff surfaces |

For contractor payments the natural split is **A** for the contractor-facing page (it must
work from an emailed link on any device, and it must accept a file upload + bank details,
exactly like `/reimburse/`) and **C** for the staff pre-fill + approval queue.

### 1.2 Token minting, storage, scoping, expiry, hashing

There are **two** token conventions in the repo.

**(a) The money-guarding convention — `crypto.randomUUID()`, stored PLAINTEXT, no expiry.**

`apps/convex/reimbursements.ts:1081`
```ts
const now = Date.now();
const token = crypto.randomUUID();
```

`apps/convex/repaymentLinks.ts:108`
```ts
const token = crypto.randomUUID();
await ctx.db.insert("repaymentLinks", {
  chapterId, payerPersonId, token,
  createdByPersonId: await resolveCallerPersonId(ctx, chapterId),
  createdAt: Date.now(),
});
```

`schema/finances.ts` (repaymentLinks doc comment) states the standard explicitly:

> The token is `crypto.randomUUID()`, matching `reimbursementRequests.token` — the codebase's
> existing standard for a secret that guards money.

- **Stored:** plaintext in the row's `token` field. **NOT hashed.** (`lib/sha256.ts` exists
  but is not used for these tokens.)
- **Index:** always `.index("by_token", ["token"])`, and lookups always go
  `.withIndex("by_token", q => q.eq("token", token)).unique()`.
- **Scope:** the token authorizes **one row and one verb set**. Every id the client submits is
  re-checked against the token's own row server-side. `repaymentLinks.ts`'s header is the
  canonical statement of that discipline:
  > THE TOKEN IS THE ONLY AUTHORITY, AND IT AUTHORIZES EXACTLY ONE THING … every id the
  > client submits is re-checked against the token's `payerPersonId` server-side. The client
  > supplies which charges to settle; it never supplies an amount.
- **Expiry:** none. Instead there is **status gating** (`EDITABLE_STATUSES`,
  `LINKABLE_STATUSES` in `reimbursements.ts:341/356`) and **revocation** (`repaymentLinks.revokedAt`).
  `repaymentLinks.ts` records the founder's reasoning: no auto-expiry because "a link that dies
  on its own mostly generates 'this link is broken' messages."
- **Unknown vs revoked are indistinguishable** to the caller — one "this link isn't active"
  state, deliberately, so tokens can't be probed.

**(b) The TTL convention — `projectEmailTokens`, 30-day capability.**

`apps/convex/projectActions.ts:26`
```ts
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
```
`schema/projects.ts:92` carries `expiresAt: v.number()` + `.index("by_expiry", ["expiresAt"])`,
and `liveToken()` returns null when `row.expiresAt < Date.now()`. Minting **reuses** an
existing token while it has `REUSE_MIN_REMAINING_MS` left.

**Recommendation for contractor agreements:** copy convention (a) — plaintext
`crypto.randomUUID()`, `by_token` index, no expiry, status-gated + revocable. That matches
"guards money" and matches every sibling. If a TTL is wanted, copy (b)'s `expiresAt` +
`by_expiry` shape verbatim.

### 1.3 Routing in `http.ts`

`apps/convex/http.ts` is the whole public HTTP surface (1921 lines). Structure:

```ts
const http = httpRouter();
auth.addHttpRoutes(http);                 // auth callbacks
registerTicketApiRoutes(http);            // /api/tickets/*
registerReimburseApiRoutes(http);         // /api/reimburse/*
registerGiveApiRoutes(http);              // /api/give/*
registerBlogApiRoutes(http);              // /api/blog/*
```

The GET page route (`http.ts:1562`):

```ts
http.route({
  pathPrefix: "/reimburse/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["reimburse", slug]
    const rawSlug = segments[1];
    if (!rawSlug) return html(renderReimburseNotFound(), 404);
    let slug: string;
    try { slug = decodeURIComponent(rawSlug); }
    catch { return html(renderReimburseNotFound(), 404); }

    const chapter = await ctx.runQuery(api.lib.reimburseApiRoutes.chapterForReimburse, { slug });
    if (!chapter) return html(renderReimburseNotFound(), 404);

    const token = url.searchParams.get("token");
    if (token) {
      const view = await ctx.runQuery(api.reimbursements.getPublicReimbursement, { token });
      return view
        ? html(renderReimburseStatus(view, chapter.name, token, slug))
        : html(renderReimburseNotFound(), 404);
    }
    return html(renderReimburseForm(chapter));
  }),
});
```

Conventions worth copying verbatim:
- `pathPrefix` + manual `pathname.split("/").filter(Boolean)` segment parsing (Convex has no
  path params).
- One `html(body, status)` helper (`http.ts:107`) sets `Content-Type: text/html; charset=utf-8`.
- **GET is always read-only.** `http.ts` (`/p/` routes) and `reimburseApiRoutes.ts` both state
  the rule: mail scanners prefetch links, so any state change must be a POST behind a button.
- A route carrying a secret in the query string must never return a cacheable response —
  see `previewHtml` (`http.ts:410`) with `Cache-Control: no-store, private`, and the long
  comment at `http.ts:479` about CDN cache keys.

### 1.4 The `*ApiRoutes.ts` POST-back pattern

`apps/convex/lib/reimburseApiRoutes.ts` is the reference (461 lines). Shape:

```ts
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function errorJson(err: unknown): Response {
  const message = (err as { data?: { message?: string } })?.data?.message
    ?? "Something went wrong. Please try again.";
  return json({ error: message }, 400);
}

function jsonPost(run: (ctx: ActionCtx, body: JsonBody, req: Request) => Promise<unknown>) {
  return httpAction(async (ctx, req) => {
    try {
      const body = (await req.json()) as JsonBody;
      return json((await run(ctx, body, req)) ?? { ok: true });
    } catch (err) { return errorJson(err); }
  });
}

export function registerReimburseApiRoutes(http: HttpRouter): void {
  http.route({ path: "/api/reimburse/submit", method: "POST", handler: jsonPost(async (ctx, body, req) => { … }) });
  …
}
```

Key details:
- **Thrown `ConvexError({code, message})` → HTTP 400 with `{error: message}`.** Every backend
  refusal in this codebase is a `ConvexError`, never a plain `Error`.
- **Client IP** is not available to a mutation. `clientIpFromRequest(req)`
  (`reimburseApiRoutes.ts:72`) reads the **LAST** entry of `x-forwarded-for` (the only
  unspoofable hop), falling back to `x-real-ip`, and the httpAction forwards it as an argument.
- **Untrusted JSON is coerced in the route file**, not the mutation: `toLines`, `toCoding`,
  `toRevisedLines`, `optStr`. Enum values are checked against the shared tuples so an
  unrecognized value produces a fixable message instead of an opaque Convex validator 400.
- The route file **also registers public `query` functions** (`chapterForReimburse`,
  `linesForToken`) — they live here rather than in the domain file because they exist only
  for this page. They are reachable as `api.lib.reimburseApiRoutes.chapterForReimburse`.
- **The httpAction ORCHESTRATES multi-step flows.** `/api/reimburse/submit` runs an *action*
  (`linkPublicBankAccount`, which does network I/O) and *then* a *mutation*
  (`submitPublicReimbursement`). That split is required: a mutation cannot `fetch`.

### 1.5 HTML building

- `apps/convex/lib/html.ts` is 16 lines: one `escapeHtml(s)` escaping `& < > " '`. Every
  renderer uses it, usually aliased `import { escapeHtml as esc } from "./html"`.
- Pages are **plain template-literal strings**. `lib/reimbursePage.ts` (997 lines) holds:
  - `const SYMBOLS` — an inline `<svg><defs><symbol>` sprite referenced via `<use href="#i-x"/>`.
  - `const REIMBURSE_CSS` — the whole stylesheet as a string, tokens in `:root{--surface:…}`.
  - `head()`, `pubbar()` — small composable fragments.
  - `renderReimburseForm(chapter)`, `renderReimburseStatus(view, …)`, `renderReimburseNotFound()`.
- Shared font/favicon constants live in `lib/landingPageStyles.ts` (`FONTS`, `FAVICON`).
- Larger pages split styles out: `lib/givePageStyles.ts` (302 lines),
  `lib/publicLedgerPageStyles.ts`, `lib/landingPageStyles.ts`.

### 1.6 The client-side JS pattern (`*PageClient.ts`)

There **is** a client-script pattern, two variants:

- **Inline const in the page file** — `reimbursePage.ts` holds `REIMBURSE_FORM_SCRIPT`,
  `REIMBURSE_STATUS_SCRIPT`, `REIMBURSE_CODING_SCRIPT` as strings.
- **Separate file** — `lib/givePageClient.ts` (387 lines), `lib/landingPageClient.ts`,
  `lib/landingPageVerifyClient.ts`.

Injection is a two-`<script>` handshake — data first, then code:

```ts
const init = JSON.stringify({ slug, name, namesMax, minPurpose, categories })
  .replace(/</g, "\\u003c");        // XSS guard for </script> in data
…
<script>window.__REIMB__=${init};</script>
<script>${REIMBURSE_FORM_SCRIPT}</script>
```

**Hard constraint documented in `reimbursePage.ts`'s header: the client script deliberately
avoids template literals so it can be assembled inside one.** It is ES5-flavoured vanilla JS
(`var`, `function`, `.then()`), no bundler, no framework.

### 1.7 ★ COMPLETE END-TO-END TRACE — the public reimbursement

This is the single most transferable artifact in the report. Every step is a real symbol.

```
┌─ STEP 0 · There is no "mint" for reimbursements ────────────────────────────┐
│ The reimburse page is discovered by chapter SLUG, not by a minted token.    │
│ The token is minted BY the submission (step 6) and returned to the browser  │
│ once. Contrast repaymentLinks.mintLink (below), which is the mint-first     │
│ pattern you want for contractor agreements.                                 │
└─────────────────────────────────────────────────────────────────────────────┘

STEP 1 · GET the form
  Browser  →  GET /reimburse/new-york
  apps/convex/http.ts:1562  (pathPrefix "/reimburse/", method GET)
    ctx.runQuery(api.lib.reimburseApiRoutes.chapterForReimburse, { slug })
      → lib/reimburseApiRoutes.ts:403 — PUBLIC query, no auth.
        Returns { slug, name, namesMaxHeadcount, minPurposeLength, categories[] }
        (active budget categories with §274(d) expenseTypeHint)
    no ?token → html(renderReimburseForm(chapter))
      → lib/reimbursePage.ts:249 — returns a full <!doctype html> string with
        window.__REIMB__ = <init JSON> and REIMBURSE_FORM_SCRIPT inlined.

STEP 2 · Claimant fills the form
  Fields (lib/reimbursePage.ts:249-335): f_name, f_email, f_purpose,
  per-line {desc, date, amount, receipt file, category, §274(d) coding},
  f_routing, f_account, f_holder, f_funding, f_planned.

STEP 3 · Upload each receipt BEFORE submitting  (THE UNAUTH UPLOAD MECHANISM)
  client (lib/reimbursePage.ts:816):
    function uploadFile(file){
      return api('/api/reimburse/pre-upload-url',{chapterSlug:R.slug}).then(function(r){
        return fetch(r.uploadUrl,{method:'POST',
                     headers:{'Content-Type':file.type||'application/octet-stream'},
                     body:file})
          .then(function(res){if(!res.ok)throw new Error('Upload failed');return res.json();})
          .then(function(j){return j.storageId;});
      });
    }
  →  POST /api/reimburse/pre-upload-url            (lib/reimburseApiRoutes.ts:284)
  →  api.reimbursements.preSubmitUploadUrl          (reimbursements.ts:1451)
       PUBLIC mutation. Resolves chapter by slug (404 if unknown).
       assertNotRateLimited(ctx, `upload_ip:${ip}`, 40, 1h) + recordAttempt.
       return await ctx.storage.generateUploadUrl();
  →  browser POSTs the file straight to Convex storage, gets { storageId }.

STEP 4 · Create the ACH destination (action — network I/O)
  →  POST /api/reimburse/submit  (lib/reimburseApiRoutes.ts:234) ORCHESTRATES:
     const bank = await ctx.runAction(api.reimbursements.linkPublicBankAccount, {
       routingNumber, accountNumber, accountHolderName, funding, clientIp });
  →  api.reimbursements.linkPublicBankAccount     (reimbursements.ts:2109) PUBLIC action
       assertRoutingNumber(...)  // 9 digits, lib/increaseApi.ts:357
       assertAccountNumber(...)  // 4–17 digits, lib/increaseApi.ts:371
       ctx.runQuery(internal.reimbursements.beginLinkPublicBankAccount, { token })
         → token absent = pre-submit path, no gate
       ctx.runMutation(internal.reimbursements.assertBankLinkNotRateLimited, { clientIp })
         → `banklink_ip:` key, 20 / hour
       createExternalAccountRaw(...)  (reimbursements.ts:1290)
         → ctx.runAction(internal.increaseExternalAccounts.createExternalAccount, …)
             (increaseExternalAccounts.ts:49)
             increaseEnvForMode(sandboxMode) → { key, base }
             increasePost(key, base, "/external_accounts", {
               routing_number, account_number, description,
               account_holder: "individual", funding });
             // NO Idempotency-Key here, deliberately — see its comment
             return { externalAccountId: account.id, last4: accountNumber.slice(-4) }
       returns { linked: true, externalAccountId, last4 }
     If !bank.linked → throw ConvexError BANK_LINK_FAILED → 400, nothing written.

STEP 5 · Submit (mutation — the write)
  →  ctx.runMutation(api.reimbursements.submitPublicReimbursement, {
        chapterSlug, payeeName, payeeEmail, payeePhone, purpose,
        requestPreApproval, plannedPurchaseDate, lines,
        externalAccountId: bank.externalAccountId,       // ← never raw digits
        bankAccountLast4: bank.last4, clientIp })
  →  reimbursements.ts:1346  PUBLIC mutation
       chapter by slug
       assertSubmitNotRateLimited(`ip:…`) + (`email:…`)   // 5 / hour each
       matchPerson(ctx, chapterId, normalizedEmail, phone)  // best-effort roster link
       sanitizePublicCategoryId(...) per line  // silently drops foreign/inactive ids
       createReimbursement(ctx, {...})

STEP 6 · createReimbursement — the single invariant owner  (reimbursements.ts:876)
       cap/validate payeeName(120), payeeEmail(254, must contain @), purpose(2000)
       externalAccountId REQUIRED → else ConvexError BANK_REQUIRED
       "For" tag: event XOR project XOR recurring budget, each requireInChapter
       1..100 lines; assertLineCents; assertTransactionDate (−3y..+48h);
       codingFieldProblems(...) per line (shared with the in-app form)
       const token = crypto.randomUUID();
       status = requestPreApproval ? "pending_preapproval" : "submitted"
       ctx.db.insert("reimbursementRequests", { chapterId, token, status, …,
                     totalCents, externalAccountId, bankAccountLast4, submittedAt })
       ctx.scheduler.runAfter(0, internal.reimbursements.sendReimbursementSubmittedEmail,
                              { reimbursementId })
       insert reimbursementLineItems (order-indexed, fund defaulted to General Fund)
       return { token, reference: referenceFor(id), reimbursementId }
    → 200 { token, reference }; the client redirects to
      /reimburse/<slug>?token=<token>

STEP 7 · The approver email (scheduled internalAction)
  internal.reimbursements.sendReimbursementSubmittedEmail   (reimbursements.ts:2989)
    ctx.runQuery(internal.reimbursements.getReimbursementSubmittedEmailPayload)
      → recipients = listChapterFinanceManagerPersonIds(ctx, chapterId)
                     MINUS req.personId MINUS anyone whose normalized email == payee's
                     (mirrors assertApprovalSoD's two signals), deduped by email
    emailShell(emailHeading(…) + emailParagraph(…) + emailButtonRow(appUrl("/finances/reimbursements"), "Review it →"))
    for each recipient: try { await sendEmail(ctx, {to, subject, html}) } catch { log }
    whole body wrapped in try/catch — a Resend hiccup must never fail a committed write

STEP 8 · Claimant returns to the status page
  GET /reimburse/new-york?token=<uuid>
  → api.reimbursements.getPublicReimbursement (reimbursements.ts:1778)
      byToken → reference, status, statusLabel, reviewNote, payeeName, totalCents,
                approvedCents, lines[] (with lineId + per-line coding), timeline[]
      NEVER returns the token itself.
  → renderReimburseStatus(view, chapterName, token, slug)  (lib/reimbursePage.ts:340)

STEP 9 · The revision loop (if sent back)
  Manager: api.reimbursements.requestChanges({reimbursementId, note})  → status
    "changes_requested", schedules sendReimbursementChangesRequestedEmail
  Claimant: the SAME status page is the revise form. It POSTs
    /api/reimburse/resubmit → api.reimbursements.resubmitPublicReimbursement
    → applyRevisionAndResubmit → status back to "submitted"
  (POST, never GET — reimburseApiRoutes.ts:325 states why: mail scanners.)

STEP 10 · Approval
  api.reimbursements.approve({reimbursementId, approvedLineIds?})  (reimbursements.ts:2486)
    loadForManage → requireChapterId + requireFinanceManager
    assertTransition(req.status, REVIEWABLE_STATUSES, "approve")
    assertApprovalSoD(callerPersonId, callerEmail, req)
    per-line `approved` flags; approvedCents = sum of approved lines
    patch { status:"approved", approvedCents, reviewedByPersonId, approvedAt }
    ctx.db.insert("approvals", {…})  // append-only audit
    scheduler.runAfter(0, internal.reimbursements.sendReimbursementApprovedEmail)

STEP 11 · Money out — see §3.
STEP 12 · Ledger + public ledger — see §2.3 / §4.
```

**And the mint-first sibling** (what a contractor agreement link should copy),
`apps/convex/repaymentLinks.ts`:

```
mintLink (authed mutation, requireRepaymentsCollect)
  → idempotent per person: reuse the live un-revoked row, else
      const token = crypto.randomUUID();
      ctx.db.insert("repaymentLinks", {chapterId, payerPersonId, token, createdByPersonId, createdAt})
  → returns { token, url: appUrl(repaymentLinkPath(token)) }   // "/pay/<token>"
  → linkUrl() logs console.error and returns null when APP_URL is unset — degrade LOUDLY
revokeLink (authed mutation) → patch revokedAt on every live link for that person
publicByToken (PUBLIC query, no auth) → loadLiveLink() → null on unknown OR revoked
```

---

## 2. Reimbursements — the closest sibling

### 2.1 Table shapes

**`reimbursementRequests`** — `apps/convex/schema/finances.ts:809`

```
chapterId          v.id("chapters")
token              v.string()                    // secret, by_token, never in list queries
status             union(...REIMBURSEMENT_STATUSES)
payeeName          v.string()
payeeEmail         v.optional(v.string())
payeePhone         v.optional(v.string())
personId           v.optional(v.id("people"))    // best-effort roster match (SoD anchor)
identityVerified   v.optional(v.boolean())       // true only on the authed in-app path
purpose            v.optional(v.string())
plannedPurchaseDate      v.optional(v.number())
purchaseFollowUpSentAt   v.optional(v.number())
eventId | projectId | budgetId   v.optional(...)  // mutually exclusive "For" tag
totalCents         v.number()
approvedCents      v.optional(v.number())        // partial approval
preApprovedByPersonId    v.optional(v.id("people"))
reviewedByPersonId       v.optional(v.id("people"))
rejectedReason           v.optional(v.string())
reviewNote               v.optional(v.string())  // send-back note, cleared on resubmit
bankAccountLast4         v.optional(v.string())  // display only
externalAccountId        v.optional(v.string())  // ← the Increase reference id
payoutId                 v.optional(v.id("payouts"))
submittedAt | approvedAt | paidAt   v.optional(v.number())
approvedNoticeSentAt     v.optional(v.number())  // exactly-once email guard
paidNoticeSentAt         v.optional(v.number())  // ditto, CLEARED on ACH return
createdAt, updatedAt     v.number()

indexes: by_chapter | by_token | by_chapter_and_status | by_person | by_event
```

**`reimbursementLineItems`** — `schema/finances.ts:932`

```
chapterId, reimbursementId, description, amountCents
fundId?, categoryId?, eventId?, projectId?
receiptStorageId?  v.id("_storage")   // REQUIRED server-side, optional only for legacy rows
transactionDate?   v.number()          // ditto
── §274(d) substantiation, PER LINE ──
expenseType?       union(EXPENSE_TYPES)      // general|travel|meal|lodging
businessPurpose?   v.string()
travelFrom? travelTo?  v.string()
headcount?         v.number()
attendees?         array({personId?, name, affiliation})   // bounded by names threshold
groupDescription?  v.string()
approved?          v.boolean()         // partial approval
matchedTransactionId?  v.id("transactions")   // NEVER WRITTEN today
order              v.number()
indexes: by_chapter | by_reimbursement
```

**`payouts`** — `schema/finances.ts:1174`

```
chapterId, reimbursementId (← the idempotency key), payeePersonId?
amountCents, provider ("increase"|"manual"), status (PAYOUT_STATUSES)
increaseTransferId?, bankAccountLast4?, transactionId?, failureReason?
createdAt, updatedAt
indexes: by_chapter | by_reimbursement | by_increase_transfer | by_chapter_and_status
```

**`reimbursementSubmitAttempts`** — `schema/finances.ts:2388` — the shared rate-limit ledger
(`key` = `"ip:…"` / `"email:…"` / `"upload_ip:…"` / `"banklink_ip:…"`, `createdAt`),
`by_key_and_time` + `by_time`. Swept daily by `maintenance.sweepRateLimitAttempts`.

### 2.2 Statuses and transitions

`packages/shared/src/finance.ts:1495`
```ts
export const REIMBURSEMENT_STATUSES = [
  "pending_preapproval", "preapproved", "submitted",
  "changes_requested", "approved", "paying", "paid",
  "rejected", "failed", "canceled",
] as const;
export const REIMBURSEMENT_TERMINAL_STATUSES = ["paid","rejected","canceled"];
```

Transition guards, all in `apps/convex/reimbursements.ts`:

| Set | Line | Members |
|---|---|---|
| `EDITABLE_STATUSES` | 341 | claimant/manager may still edit |
| `LINKABLE_STATUSES` | 356 | editable **+ `approved`** (so a bounce can be fixed) |
| `PRE_PAYOUT_STATUSES` | 367 | reject/cancel legal only here |
| `REVIEWABLE_STATUSES` | 381 | approve / requestChanges legal only here |
| `assertTransition(current, allowedFrom, verb)` | 387 | throws `ILLEGAL_TRANSITION` |

Mutations: `preApprove` (2463), `approve` (2486), `requestChanges` (2571), `reject` (2620),
`cancel` (2650), `resubmitPublicReimbursement` (1967), `resubmitMyReimbursement` (1987).

Separation of duties: `assertApprovalSoD` (approver ≠ requester, by BOTH `personId` and
normalized email) and `assertDisbursementSoD` (`lib/increaseShapes.ts:189` — payer ≠ payee),
both built on `lib/finance.ts:609#assertSeparationOfDuties`, which throws `SOD_VIOLATION`.

### 2.3 Approved → money out → ledger

```
approve  (status "approved", approvedCents)
   │
   ├── ACH path ────────────────────────────────────────────────────────────
   │   api.increasePayouts.payReimbursement (action, increasePayouts.ts:300)
   │     internal.increasePayouts.beginPayout (mutation, :64)
   │       requireFinanceManager; status must be "approved"
   │       assertDisbursementSoD; assertPositivePayout
   │       IDEMPOTENT: an existing LIVE payout (by_reimbursement) returns as-is
   │       canAch = accountEnvKey && account.onboardingStatus==="active"
   │                && account.increaseAccountId && !!req.externalAccountId
   │       insert payouts {provider: canAch?"increase":"manual", status:"pending"}
   │     increaseEnvForObjectId(result.increaseAccountId) → { key, base }
   │     increasePost(key, base, "/ach_transfers", {
   │        account_id, amount: amountCents,          // POSITIVE = credit out
   │        statement_descriptor: "Reimburse",        // Increase caps at 10 chars
   │        individual_name: payeeName.slice(0,22),   // NACHA receiver name
   │        external_account_id                        // ← the destination
   │      }, String(reimbursementId))                 // ← Idempotency-Key
   │     internal.increasePayouts.applyAchTransfer (:215)
   │       dead-replay guard (terminal status OR id already on another payout)
   │       payout → "processing" + increaseTransferId
   │       reimbursement → "paying"
   │
   └── manual path ──────────────────────────────────────────────────────────
       api.increasePayouts.markPaidManually (mutation, :442)
         refuses when a live provider:"increase" payout has an increaseTransferId
         payout → "paid"; then settleReimbursementPaid(...)

Webhook lands (§3.3) → onIncreaseWebhookEvent → applyPayoutOutcome(target:"paid")
   → settleReimbursementPaid (lib/increasePayoutMachine.ts:152)
        req → "paid", paidAt, payoutId
        schedules internal.reimbursements.sendReimbursementPaidEmail
        postReimbursementSpend(...)
```

**`postReimbursementSpend`** — `lib/increasePayoutMachine.ts:47` — is where a reimbursement
becomes a ledger row. **Idempotent via `transactions.by_reimbursement`.**

```ts
const ported = await deriveReimbursementTxnFields(ctx, req);   // lib/reimbursementTxnFields.ts
const txnId = await ctx.db.insert("transactions", {
  chapterId, source: "reimbursement",
  flow: "outflow",                    // ← THE EXPENSE ITSELF; counts toward budget/category
  amountCents: payout.amountCents, currency: "usd", postedAt: now,
  personId: req.personId, reimbursementId: req._id,
  status: "reconciled", createdAt: now,
  ...ported,                          // description/merchant/budget/event/project/category/fund
});
await ctx.db.patch(payout._id, { transactionId: txnId, updatedAt: now });
await materializeReimbursementReceipts(ctx, { req, transactionId: txnId, chapterId });
// ↑ turns each line's receiptStorageId into a REAL `receipts` row + `receiptLinks`
const { namesMaxHeadcount } = await codingPolicy(ctx);
const materialization = await deriveReimbursementCodingMaterialization(ctx, req, namesMaxHeadcount);
if (materialization.eligible) {
  await materializePortedReimbursementCoding(ctx, { transactionId: txnId, scope: chapterId, … ,
    portedFromReimbursementId: req._id });
}
```

That is the whole coding-and-ledger story: **the payout transaction carries the
reimbursement's own attribution, its receipts become real documents, and a single-line
complete request has its §274(d) testimony ported into an approved `transactionCodings` row
without anyone re-typing it.** From there §4's publish pipeline picks it up.

`flow:"outflow"` (not `"transfer"`) is load-bearing and was a bug fix — see the long comment
at `lib/increasePayoutMachine.ts:36` and migration `0044_reimbursement_payouts_outflow`.

---

## 3. Increase / ACH

Module map (`increase.ts`'s header is the authority):

| File | Lines | Role |
|---|---|---|
| `apps/convex/increase.ts` | 165 | webhook signature verify, `handleIncreaseWebhook` fetch-then-apply |
| `apps/convex/increaseAccounts.ts` | 389 | chapter Increase Account reads |
| `apps/convex/increaseProvision.ts` | 557 | Entity + Account provisioning |
| `apps/convex/increaseExternalAccounts.ts` | 112 | **`POST /external_accounts`** — the ACH destination primitive |
| `apps/convex/increasePayouts.ts` | 610 | begin/pay/mark-paid + webhook entry point |
| `apps/convex/increaseLedger.ts` | 697 | posted-transaction ingest |
| `apps/convex/lib/increaseApi.ts` | 380 | env resolution, `increaseGet/Post/Patch`, validators |
| `apps/convex/lib/increasePayoutMachine.ts` | 347 | **pure** state machine + `postReimbursementSpend` |
| `apps/convex/lib/increaseShapes.ts` | 204 | validators, SoD asserts, status tuples |

### 3.1 Creating an external bank account

`increaseExternalAccounts.ts:49` — `createExternalAccount`, an **internalAction**.

Fields sent: `routing_number`, `account_number`, `description` (≤200 chars, the account-holder
name), `account_holder: "individual"` (hard-coded), `funding` (`"checking" | "savings"` from
`EXTERNAL_ACCOUNT_FUNDINGS`).

Validation happens **before** any query or network call, in the caller
(`linkPublicBankAccount` / `linkBankAccount`):
- `assertRoutingNumber` (`lib/increaseApi.ts:357`) — strip non-digits, must be exactly 9.
- `assertAccountNumber` (`lib/increaseApi.ts:371`) — strip non-digits, 4–17.
Both throw `ConvexError({code:"INVALID_INPUT"})` and **never log or persist the value**.

**PERSISTENCE ANSWER — the account number is NEVER persisted in Convex.** Only
`externalAccountId` (Increase's reusable object id) and `bankAccountLast4` (computed as
`args.accountNumber.slice(-4)` at link time) are stored. Three separate guards enforce it:
1. `createExternalAccount` returns only `{externalAccountId, last4}`.
2. On a missing id it logs **only the response key names**, because "Increase's External
   Account object echoes back the full `account_number` / `routing_number`, which must never
   land in logs."
3. `increasePost` (`lib/increaseApi.ts:126`) special-cases the path:
   `const sensitive = path.includes("/external_accounts");` → logs
   `describeIncreaseError(status, body)` (status + Increase's `title`/`detail` only) instead
   of the raw body.

**No `Idempotency-Key` on `/external_accounts`**, deliberately — a person legitimately
changing bank details mid-request must get a fresh object; a stable key would return the
stale one and address money to the wrong account.

Degrades to `null` (never throws) when the key is unset or the call fails.

### 3.2 Initiating an ACH transfer + idempotency

`increasePayouts.ts:353` (inside `payReimbursement`):

```ts
const transfer = await increasePost(key, base, "/ach_transfers", {
  account_id: result.increaseAccountId,
  amount: result.amountCents,            // POSITIVE cents = a CREDIT pushing funds out
  statement_descriptor: "Reimburse",     // Increase max 10 chars
  individual_name: result.payeeName.slice(0, 22),  // NACHA receiver name, max 22
  ...destination,                        // { external_account_id } XOR { account_number, routing_number, funding }
}, String(reimbursementId));             // ← Idempotency-Key
```

`increasePost` (`lib/increaseApi.ts:104`) sets `Idempotency-Key: <key>` when supplied.

**Idempotency story, in three layers:**
1. **`payouts.reimbursementId` is the DB idempotency key** — `beginPayout` returns an existing
   `LIVE_PAYOUT_STATUSES` payout untouched, so an approved reimbursement can never double-pay.
2. **`Idempotency-Key = reimbursementId`** at Increase — a network-timeout retry replays the
   SAME transfer rather than originating a second.
3. **The dead-replay guard** (`applyAchTransfer:215`). Increase idempotency keys never expire.
   After a paid→returned reversal, re-paying replays the original *bounced* transfer. Detected
   two ways: (a) the replayed transfer's status is in `TERMINAL_TRANSFER_STATUSES`, or (b)
   another payout already holds this `increaseTransferId`. On either, fail this payout with
   `failureReason: "idempotent_replay"` and leave the reimbursement `approved` so
   `markPaidManually` still works. Deliberately does **not** trigger on the
   `Idempotent-Replayed` header alone (a legitimate timeout-retry replays a *live* transfer
   that must be adopted).

### 3.3 Webhooks

`http.ts:1184` — `POST /increase/webhook`:
```
INCREASE_WEBHOOK_SECRET unset → 500 "Not configured"
verifyIncreaseSignature(payload, {webhook-id, webhook-timestamp, webhook-signature}, secret)
  → Standard Webhooks; invalid → 400
Event shape: { id, category, associated_object_id, type:"event" } — NO inline object.
  real_time_decision.*  → SYNCHRONOUS, NOT deduped, awaited before 200
  everything else       → internal.webhooks.recordWebhookEvent({provider:"increase", eventId})
                          if isNew → ctx.runAction(internal.increase.handleIncreaseWebhook,
                                       {category, associatedObjectId})
```

`webhooks.ts` (55 lines) is the shared dedup ledger for stripe/increase/twilio/resend:
`recordWebhookEvent` inserts into `webhookEvents` keyed `by_provider_and_event` and returns
`{isNew}`.

`internal.increase.handleIncreaseWebhook` FETCHES the object (`GET /ach_transfers/{id}`,
because the event carries no status) and calls
`internal.increasePayouts.onIncreaseWebhookEvent({eventType, transferId, status})`, which
matches `payouts.by_increase_transfer` (no match → silent no-op).

### 3.4 The payout state machine

`packages/shared/src/finance.ts:2179`
```ts
export const PAYOUT_STATUSES = ["pending","processing","paid","failed","returned","canceled"];
export const PAYOUT_PROVIDERS = ["increase","manual"];
```

`lib/increasePayoutMachine.ts:193` — `payoutTargetFor(eventType, status)`:

| Increase ACH-transfer status | payout target |
|---|---|
| `returned` | `returned` |
| `rejected` / `canceled` / `failed` / `declined` | `failed` |
| **`submitted`** (also `settled`/`paid`, forward-compat) | **`paid`** |
| `pending_approval` / `pending_submission` / `pending_reviewing` / `pending_transfer_session_confirmation` | `processing` |
| `requires_attention` | `null` — no change, a human investigates |
| unrecognized, with a `created`/`updated` carrier event | `processing` |

**Critical domain fact, documented at `lib/increasePayoutMachine.ts:180`: an outbound ACH
credit has no post-settlement "settled" status. `submitted` IS terminal success. A `returned`
can arrive days later.**

`applyPayoutOutcome` (`:304`) guards:
- `canceled` → fully terminal.
- `returned` / `failed` → terminal, but a repeat delivery is an idempotent no-op.
- `paid` → terminal **except** a late `returned`, which runs `reverseSettledPayout` (`:253`):
  payout → `returned` + `failureReason`, `transactionId` cleared, reimbursement walked back to
  `approved` with `paidAt` and **`paidNoticeSentAt` cleared** (so the retry's real payment gets
  its own notice), and **the ledger transaction is DELETED** — because
  `postReimbursementSpend` looks up `by_reimbursement` unconditionally, so leaving it would
  make a future successful re-pay think spend was already booked.
- pre-paid `failed`/`returned` walk a `paying` reimbursement back to `approved`.

Tested end-to-end in `apps/convex/tests/achLateReturn.test.ts`.

### 3.5 Sandbox / test-mode guards

Three mechanisms, all mandatory to respect:

1. **The env is in the object id prefix.** `lib/increaseApi.ts:29`
   ```ts
   export function increaseEnvForObjectId(objectId: string) {
     if (objectId.startsWith("sandbox_"))
       return { key: process.env.INCREASE_SANDBOX_API_KEY, base: "https://sandbox.increase.com" };
     return { key: process.env.INCREASE_API_KEY, base: increaseApiBase() };
   }
   ```
   `payReimbursement` resolves its key from the **chapter account's** id prefix, never from
   the plain `INCREASE_API_KEY`.
2. **`increaseEnvForMode(sandbox)`** (`lib/increaseApi.ts:50`) for *creating* objects — reads
   the runtime `financeSettings.sandboxMode` toggle
   (`internal.financeSettings.readSandboxMode` / `readSandbox`). Also returns a mode-scoped
   `entityId` and `programOverride`.
3. **`matchesMode(objectId, sandboxMode)`** (`@events-os/shared`) filters reads —
   `listPayouts` hides sandbox payouts in production mode. A NULL Increase id (a manual
   payout) is environment-**neutral** and shows in both.

Env vars: `INCREASE_API_KEY`, `INCREASE_SANDBOX_API_KEY`, `INCREASE_API_BASE`,
`INCREASE_ENTITY_ID`, `INCREASE_SANDBOX_ENTITY_ID`, `INCREASE_PROGRAM_ID`,
`INCREASE_SANDBOX_PROGRAM_ID`, `INCREASE_WEBHOOK_SECRET`.

UI: `apps/mobile/components/finance/SandboxModeBanner.tsx`.

---

## 4. Coding + budgets + public ledger

### 4.1 What a "coding" IS

A **coding** is the IRS §274(d) substantiation of one transaction — the written *what/why/who*
— stored as at most one `transactionCodings` row per transaction, with its own submit → review
→ approve lifecycle. **It is not a category taxonomy** (funds/categories/budgets own that).

Author-editable substance — `packages/shared/src/finance.ts:1048`:
```ts
export interface TransactionCodingFields {
  expenseType: ExpenseType;        // "general" | "travel" | "meal" | "lodging"
  businessPurpose: string;         // ≥20 chars (MIN_PURPOSE_LENGTH), ≤2000 — PRINTS PUBLICLY
  travelFrom?: string;  travelTo?: string;      // required for travel/lodging
  headcount?: number;                            // required for meal
  attendees?: CodingAttendee[];                  // required for meal at/below the names threshold
  groupDescription?: string;                     // required for meal above it
}
```
Validated by the pure, shared `codingFieldProblems(fields, namesMaxHeadcount)`
(`packages/shared/src/finance.ts:1084`), used identically by the public page, the in-app form,
and the server — the form renders the whole problem list, the server throws the first.

Full stored row — `schema/finances.ts:2246`: adds `transactionId`, `chapterId` (chapter or
`"central"`), `travelers[]`, `status` (`TRANSACTION_CODING_STATUSES`), `codedByPersonId` /
`codedByUserId` (both optional — a materialized row's author is an accountless claimant),
`submittedAt`, `updatedAt`, `decidedBy*`, `decidedAt`, `reviewNote`, `approvalParty`
(`"single"` for a superuser self-approve, `"two_party"` otherwise), `reviewerRemindedAt`,
`portedFromReimbursementId`, and the redaction quartet:

> **REDACTION, NOT FALSIFICATION.** `businessPurpose` is and remains the AUTHOR'S OWN WORDS…
> What an approver may write is a separate, public-facing version of the same sentence,
> stored HERE, alongside it: `publicPurpose`, `publicPurposeByPersonId`,
> `publicPurposeByUserId`, `publicPurposeAt`. The published ledger renders
> `publicPurpose ?? businessPurpose`.

The **other, orthogonal dimensions** live on `transactions` itself
(`schema/finances.ts:338`): `fundId`, `categoryId`, `budgetId`, `projectId`, `eventId`,
`eventItemId`, `personId`, `engagementId`, `cardId`, `reimbursementId`. (`teamId` is a
RETIRED dimension — explicitly rejected by writers.)

Policy is runtime-configurable — `lib/transactionCoding.ts:48`:
```ts
export async function codingPolicy(ctx): Promise<{sinceMs; conversionSinceMs; namesMaxHeadcount}>
```
reading `financeSettings` with `DEFAULT_CODING_REQUIRED_SINCE_MS` (2026-09-01),
`DEFAULT_CODING_CONVERSION_SINCE_MS`, `DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT` (15).

Server helpers: `lib/transactionCoding.ts` — `submitCoding`, `decideCoding`,
`undoCodingApproval`, `normalizeCodingFields`, `codingForTransaction`,
`materializePortedReimbursementCoding`. Registered functions:
`transactionCodings.ts` — `submit`, `submitBulk`, `approve`, `undoApproval`,
`requestChanges`, `setPurpose`, `setPublicPurpose`, `reviewQueue`, `workload`,
`getForTransaction`, `budgetOptions`, `attendeeSuggestions`, `policy`.

### 4.2 Budgets

`apps/convex/budgetLines.ts` — a `budgetLines` row is a categorized chunk of a v2 `budgets`
row's `amountCents`. **Estimated-side only: `plannedCents` is NEVER summed with actuals.**
Gating mirrors `finances.ts`' budgets CRUD (viewer+ to list at the budget's level,
bookkeeper+ to write, with the ED-seat widening at central).

### 4.3 What makes a transaction show up on the public ledger

**The public page never reads the live books.** A period is **frozen** at publish, and the
frozen copy is what the world sees (`schema/publicLedger.ts` module doc). Three tables:

| Table | Role |
|---|---|
| `financePublications` | one per (book, month). `status` = working copy; `liveRevision`/`isLive` = what the public sees. They are genuinely independent |
| `financePublicationRevisions` | APPEND-ONLY. One row per published revision: frozen totals, `amendmentReason`, `note`, `preparedBy…`, `publishedBy…`, `approvalParty`, plus disclosure counts (`reconstructedCount`, `undocumentedCount`, `uncodedCount`, `unexplainedCount`, `truncated`) |
| `financePublicationEntries` | APPEND-ONLY. One row per published LINE per revision — the frozen ledger |

Republishing writes a **fresh full set** of entries rather than a diff, so "what exactly did
revision 1 say?" is answerable forever.

**Entries store rendered TEXT, not ids** — `categoryLabel: "Sundays & Worship"`, not
`categoryId` — so renaming a category next year cannot retroactively rewrite a published
statement.

The snapshot builder is `apps/convex/lib/publicLedgerSnapshot.ts` (777 lines); the read/publish
functions are `apps/convex/publicLedger.ts` (1661 lines); the shared vocabulary is
`packages/shared/src/publicLedger.ts` (452 lines); the HTML is `lib/publicLedgerPage.ts` +
`lib/publicLedgerPageStyles.ts`; CSVs `lib/publicLedgerCsv.ts`; staleness
`lib/publicLedgerStale.ts`. Routes: `http.ts:431` (`/finances`) and `http.ts:468`
(`/finances/<YYYY-MM>`, `/finances/<YYYY>`, `.csv`, `giving.csv`, and the `?preview=<token>`
console preview).

### 4.4 Publicly exposed fields

`financePublicationEntries` (`schema/publicLedger.ts:341`):

Common: `publicationId`, `revision`, `scope`, `periodKey`, `kind` (`"ledger"|"gift"`),
`occurredAt`, `amountCents`, `direction` (`"in"|"out"|"internal"`), `countsInTotals`,
`bookLabel`.

Ledger-only: `counterparty`, `purpose`, `categoryLabel`, `fundLabel`, `budgetLabel`,
`projectLabel`, `eventLabel`, `expenseType`, `travelFrom`, `travelTo`, `headcount`,
`affiliationMix`, `groupDescription`, `documentation`, `reconstructed`,
`nonDiscretionaryFee`, and `sourceTransactionId` (**internal only — dropped by the public
projector**).

Gift-only: `method`, `designation`.

`countsInTotals` is why internal transfers and processor payouts can publish while summing to
nothing: `sum(amountCents where countsInTotals && direction==="out") === expenseCents`,
exactly, verifiable from the CSV.

### 4.5 PII handling — three separate rules

1. **A gift entry carries NO donor field at all.** Not "omitted from the projection" —
   genuinely not written. `schema/publicLedger.ts`:
   > No donor id, no gift id, no name, no email, no external reference… A row in a table that
   > an anonymous HTTP route reads should not contain a field whose safety depends on every
   > present and future query remembering to drop it.

2. **Attendee and traveler NAMES never publish** (owner decision 2026-08-08 — "some are
   minors"). `headcount` + `affiliationMix` (`{team: 5, community_member: 7}`) publish
   instead.

3. **"A gift on the public ledger is a gift, and names nobody"** — the recent fix, at
   `lib/publicLedgerSnapshot.ts:500`:
   ```ts
   // A GIVER IS NEVER NAMED HERE. Gifts publish as an anonymous roll, and
   // the page says so in as many words: "No names, no amounts tied to a
   // person, no way to work backwards to one." A wire's bank descriptor IS
   // the sender's name, so publishing this row's merchant printed a named
   // giver and their $7,000 two inches above that promise…
   counterparty: coveredCents > 0 ? undefined : displayMerchantName(tr),
   ```
   i.e. **a bank credit already covered by a `gifts` row publishes with no counterparty at
   all.** Coverage is computed by `lib/giftCoverage.ts#giftCoverageByTransaction`.

   ⚠ **For contractor payments this rule points the other way and needs an explicit
   decision.** A contractor payout's `counterparty` is the contractor's *name*, and it will
   publish. The redaction lever that exists today is `transactionCodings.publicPurpose`
   (`transactionCodings.setPublicPurpose`), which only redacts the *purpose* string — nothing
   redacts `counterparty`. Decide deliberately, and mirror the gift rule if the answer is "a
   contractor is not named."

### 4.6 The publishability gate

**Yes.** `apps/convex/publishability.ts` (`report` query, gated by
`lib/publishabilityAccess.ts#requirePublishabilityReport` /
`requirePublishabilityAllBooks`). A period is publishable only when all **three axes** are
green for every row that owes anything:

| Axis | Predicate | Note |
|---|---|---|
| documentation | `isUndocumented` | the **publishing** predicate, ignores status — deliberately *not* the chase-oriented `needsDocumentation` |
| coding | `requiresCoding` && `codingState !== "approved"` | not `isUncoded`, which skips reconciled rows and rows in review |
| review | reconciled by a bookkeeper+ | |

The report publishes **four independent populations**: the three axis gaps plus `blocked`
(the union), with an `overlap` breakdown — because the axes overlap freely and summing them
would produce a number corresponding to nothing. Two more lines are called out rather than
counted: `codingExempt` (spend before `codingRequiredSinceMs`) and `reconstructed`
(`isReconstructedHistory` — rebuilt from spreadsheets).

`publicLedger.publish` **refuses to publish a truncated snapshot** (a source scan that hit
`ROLLUP_SCAN_LIMIT`), and the flag is stored anyway so no revision can be read without knowing.

`lib/publicLedgerAccess.ts` gates the three verbs — see §5.4.

---

## 5. Access control

### 5.1 The shape of `SEAT_CAPABILITIES`

`packages/shared/src/seats.ts:65` re-exports it — the real definition is
`packages/shared/src/powers.ts`:

```ts
export const POWERS = [
  // ── finance ───────────────────────────────────────────────
  "finance.view", "finance.edit", "finance.accounts.view",
  "finance.cards.view", "finance.cards.edit",
  "finance.budgets.approve", "finance.ledger.publish",
  // ── giving ────────────────────────────────────────────────
  "giving.view", "giving.edit",
  // ── email ─────────────────────────────────────────────────
  "email.assets.edit", "email.campaigns.edit", "email.campaigns.approve",
  // ── events ────────────────────────────────────────────────
  "events.checkin",
  // ── org ───────────────────────────────────────────────────
  "org.chart.edit",
  // ── data ──────────────────────────────────────────────────
  "data.export",
] as const;
export type Power = (typeof POWERS)[number];
```
with `export { POWERS as SEAT_CAPABILITIES }` and `export type { Power as SeatCapability }`.

**Grammar (enforced by convention + `powers.test.ts`): `domain.area?.action`, ACTION LAST.**
Never `org.editChart`, never a role noun like `finance.manager`, never a bare resource.

Each power has a `PowerDef` (`powers.ts:150`): `{id, domain, area?, action, label,
description, implies?, scope?}`. `scope: "central"` marks a power whose resource exists only
at the org level.

**Wildcard implication is real** — `expandPowers(def.capabilities)` (`powers.ts`) turns
`finance.edit` into `finance.cards.edit` + `finance.budgets.edit` etc. **Every gate must call
`expandPowers`; a raw array compare is a bug.**

Legacy strings are still accepted by the schema validator for exactly one deploy —
`LEGACY_POWER_MIGRATION` in `powers.ts:635`, with the cleanup note in `schema/seats.ts`.

### 5.2 How a capability is granted to a seat

`packages/shared/src/seats.ts` — `SEAT_IDS` (27 ids across a central chart and a chapter
chart), `SeatDef` (`{id, title, chart, parentId, maxHolders, duties, capabilities,
legacyTitle?}`), and `SEAT_DEFS`. **Capability lists name only powers the seat is GRANTED,
never the implied rungs** — the chart renders the expanded set.

```ts
treasurer: {
  id: "treasurer", title: "Treasurer", chart: "chapter",
  parentId: "chapter_director", maxHolders: 1,
  duties: ["Record & reconcile chapter money", "Close the month", "Chase the coding"],
  capabilities: ["finance.edit", "giving.view"],
  legacyTitle: "finance_manager",
},
```

Runtime storage: `schema/seats.ts` — `seatDefs` (seeded by
`migrations/0022_seed_seat_defs.ts`, runtime-editable) and `seatAssignments`
(`{seatDefId, scope: Id<"chapters">|"central", personId, grantedBy?, createdAt}`) with
`by_scope`, `by_scope_and_seat`, `by_person`.

Effective set — `lib/seatStructure.ts:52`:
```ts
export async function effectiveCapabilities(ctx, personIds, overrides?): Promise<Set<SeatCapability>> {
  const caps = new Set<SeatCapability>();
  for (const personId of personIds) {
    const assignments = await ctx.db.query("seatAssignments")
      .withIndex("by_person", q => q.eq("personId", personId)).take(MAX_PERSON_ASSIGNMENTS);
    for (const a of assignments) {
      const def = overrides?.has(a.seatDefId) ? overrides.get(a.seatDefId)! : await ctx.db.get(a.seatDefId);
      if (!def) continue;
      for (const c of expandPowers(def.capabilities)) caps.add(c);   // EXPANDED, not raw
    }
  }
  return caps;
}
```

**Adding a new power is a three-line change**: add the string to `POWERS` + a `PowerDef`, list
it on the seats in `SEAT_DEFS`, change the resolver's body. (And per `CLAUDE.md` it is a
roles/seats change → the Academy rule applies, and `packages/shared/src/academyPaths.ts` must
still cover the seat.)

### 5.3 A complete `has*` / `require*` resolver — the template to copy

Best template overall is `lib/publicLedgerAccess.ts`'s Publish pair, because it demonstrates
the seat-capability-only shape you'll want for `contractor.approve`:

```ts
/** Bound on how many seat assignments a single person can hold. */
const PERSON_SEAT_ASSIGNMENT_LIMIT = 200;

/** True iff `personId` holds a seat AT `scope` carrying `finance.publish`. */
async function holdsPublishSeatAt(
  ctx: QueryCtx,
  personId: Id<"people">,
  scope: FinanceScope,
): Promise<boolean> {
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(PERSON_SEAT_ASSIGNMENT_LIMIT);
  for (const assignment of assignments) {
    if (assignment.scope !== scope) continue;
    const def = await ctx.db.get(assignment.seatDefId);
    if (!def || def.derived) continue;   // computed seats are never real occupancy
    if (expandPowers(def.capabilities).has("finance.ledger.publish")) return true;
  }
  return false;
}

export async function hasLedgerPublish(ctx, homeChapterId, book): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;                    // solo-operator bootstrap
  const access = await getFinanceRole(ctx, homeChapterId);
  if (!access.personId) return false;
  if (await holdsPublishSeatAt(ctx, access.personId, CENTRAL)) return true;
  if (book === CENTRAL || book !== homeChapterId) return false;
  return holdsPublishSeatAt(ctx, access.personId, book);      // chapter seat → own book only
}

export async function requireLedgerPublish(ctx, homeChapterId, book): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, homeChapterId);
  if (!(await hasLedgerPublish(ctx, homeChapterId, book))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Publishing a month to the public finances page needs a seat that carries the Publish finances power.",
    });
  }
  return access;
}
```

**The "resolver exists now, body is just the membership check" template** —
`lib/repaymentsAccess.ts` in full (74 lines) is the exemplar CLAUDE.md points at:

```ts
/** TODAY: viewer rank … Graduates to `finance.repayments.view`. */
export async function requireRepaymentsView(ctx, chapterId): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "viewer");
}
/** Non-throwing form, for deciding whether to OFFER an affordance. */
export async function hasRepaymentsCollect(ctx, chapterId): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return access.isManager || access.isCentral;
}
/** TODAY: finance manager (or central reach). Graduates to `finance.repayments.collect`. */
export async function requireRepaymentsCollect(ctx, chapterId): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "manager");
}
```

Note the discipline it models: the module doc **names the graduation strings in advance**
(`finance.repayments.view` / `.collect`) so the eventual PR doesn't invent them under
pressure.

Other complete examples: `lib/campaignsAccess.ts` (`holdsCampaignCapabilityAt` +
`CAMPAIGN_CAPABILITY_SATISFIERS`), `lib/givingAccess.ts` (`resolveGivingAccess` +
`canViewGivingScope` / `canManageGivingScope` — the FILTERING twins for lists that shouldn't
throw per row).

**For contractor payments, write `apps/convex/lib/contractorAccess.ts` on day one** with
something like `requireContractorCompose` (staff who pre-fill an agreement),
`requireContractorApprove` (the treasurer decision), `requireContractorPay` (release the ACH,
must enforce disbursement SoD), and `hasContractorCompose` for affordance decisions —
graduating to `finance.contractors.edit` / `finance.contractors.approve`.

### 5.4 Who is "the treasurer"

**Seat id: `"treasurer"`** — `packages/shared/src/seats.ts:459`, chapter chart, parent
`chapter_director`, `maxHolders: 1`, `capabilities: ["finance.edit", "giving.view"]`,
`legacyTitle: "finance_manager"`.

Nuance you must not miss:
- The chapter Treasurer's authority comes from **`finance.edit` at CHAPTER scope**, which
  wildcard-expands to `finance.cards.edit`, `finance.budgets.edit`, `finance.accounts.view`…
  but **scope, not the power, is what stops them reaching the org's bank accounts** (which
  live at `"central"`).
- The Treasurer deliberately does **not** carry `finance.ledger.publish` — the Chapter
  Director does, "so the two seats are the two parties."
- The org-level equivalents are `"financial_manager"` and `"executive_director"` on the
  central chart. `lib/finance.ts:640#isCentralEdOrFm` is the canonical "central ED or FM"
  predicate (it reads `finance.accounts.view` because BOTH seats carry it, and unions the
  seat-derived side with the legacy `specializedRoles`-title fallback).

**How to query the holders (for emailing them).** The exact pattern already exists —
`lib/finance.ts:284`:

```ts
export async function listChapterFinanceManagerPersonIds(
  ctx: QueryCtx, chapterId: Id<"chapters">,
): Promise<Set<Id<"people">>> {
  const personIds = new Set<Id<"people">>();
  const scopes: FinanceScope[] = [chapterId, "central"];
  for (const scope of scopes) {
    const grants = await ctx.db.query("financeRoles")
      .withIndex("by_chapter", q => q.eq("chapterId", scope)).take(FINANCE_ROLE_SCAN_LIMIT);
    for (const g of grants) if (g.role === "manager") personIds.add(g.personId);

    const assignments = await ctx.db.query("seatAssignments")
      .withIndex("by_scope", q => q.eq("scope", scope)).take(SEAT_ASSIGNMENT_SCAN_LIMIT);
    for (const a of assignments) {
      const def = await ctx.db.get(a.seatDefId);
      if (def && expandPowers(def.capabilities).has("finance.edit")) personIds.add(a.personId);
    }
  }
  return personIds;
}
```

That set **is** the treasurer set today (chapter Treasurer via `finance.edit`, plus central
FM, plus any stored `financeRoles` manager grant). To narrow to the literal seat, use
`by_scope_and_seat` after resolving the `seatDefs` row with `slug === "treasurer"`.

Turning ids into addresses: see `getReimbursementSubmittedEmailPayload`
(`reimbursements.ts:2928`) — walk the ids, skip `person.isPlaceholder === true`, skip anyone
whose `normalizeEmail(person.email)` matches the submitter's, dedupe by normalized email.

**Note the finance ladder is a UNION of two systems**: stored `financeRoles` grants
(`viewer`/`bookkeeper`/`manager`) AND seat-derived capabilities. `getFinanceRole`
(`lib/finance.ts:165`) resolves both. `requireFinanceRole(ctx, chapterId, min)` is the single
gate every finance read/write calls.

---

## 6. File uploads — and the unauthenticated question

### 6.1 The authenticated path

`apps/convex/storage.ts` (35 lines):
```ts
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => { await requireUserId(ctx); return await ctx.storage.generateUploadUrl(); },
});
export const getUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => { await requireUserId(ctx); return await ctx.storage.getUrl(storageId); },
});
```
Client pattern (`apps/mobile/components/campaign/designer/useImageUploader.ts:29`,
`components/finance/modals/ReceiptExceptionModal.tsx:116`,
`components/event/ticketing/CoverPhotoPicker.tsx:58`): `generateUploadUrl()` → `fetch(url,
{method:"POST", headers:{"Content-Type": file.type}, body: file})` → `{storageId}` → store the
id in your field.

`getUrl` is **auth-gated on purpose**: "a stored URL is directly servable, so a logged-out
caller must never be able to resolve an arbitrary `_storage` id into a fetchable file."

### 6.2 ★ CAN AN UNAUTHENTICATED PUBLIC PAGE UPLOAD A FILE? **YES — and the mechanism is built and in production.**

`apps/convex/reimbursements.ts:1451`:

```ts
export const preSubmitUploadUrl = mutation({
  args: { chapterSlug: v.string(), clientIp: v.optional(v.string()) },
  handler: async (ctx, { chapterSlug, clientIp }) => {
    const chapter = await ctx.db.query("chapters")
      .withIndex("by_slug", q => q.eq("slug", chapterSlug)).unique();
    if (!chapter) throw new ConvexError({ code:"NOT_FOUND", message:"We couldn't find that chapter." });
    const ipKey = capOptional(clientIp, 100);
    if (ipKey) {
      await assertNotRateLimited(ctx, `upload_ip:${ipKey}`, UPLOAD_RATE_LIMIT_MAX, UPLOAD_RATE_LIMIT_WINDOW_MS);
      await recordAttempt(ctx, `upload_ip:${ipKey}`);
    }
    return await ctx.storage.generateUploadUrl();
  },
});
```

- **No auth.** Registered as a public `mutation`.
- Reached only through `POST /api/reimburse/pre-upload-url` (`lib/reimburseApiRoutes.ts:284`),
  which forwards `clientIpFromRequest(req)`.
- Rate-limited per IP: `UPLOAD_RATE_LIMIT_MAX = 40` per rolling hour
  (`reimbursements.ts:1185`), on the shared `reimbursementSubmitAttempts` table with its own
  key prefix so it never competes with the submit budget.
- Existence of the chapter slug is the only "authorization" — deliberately, because at
  pre-submit time no request (and therefore no token) exists yet.
- Client wiring is `uploadFile()` at `lib/reimbursePage.ts:816` (quoted in §1.7 step 3).

There is also a **token-scoped** variant for replacing a file on an existing request:
`publicUploadUrl(token)` (`reimbursements.ts:1827`, requires `EDITABLE_STATUSES`) plus
`attachPublicReceipt(token, lineId, receiptStorageId)` (`:1851`, re-verifies the line belongs
to the token's request).

**For the W9, copy `preSubmitUploadUrl` exactly** — but note two things:
1. **No content-type or size validation exists on any of these paths.** The client sends
   `file.type || 'application/octet-stream'` and nothing checks it. If a W9 must be a PDF/image,
   that validation does not exist today and must be added (post-upload, reading
   `ctx.db.system.get("_storage", id)` for `contentType`/`size` — `receipts.ts` and
   `lib/imageSniff.ts` are the nearest precedent for sniffing).
2. **Reading a stored file back is auth-gated** (`storage.getUrl`). A W9 must be readable by
   the approver only. Serving a file to an unauthenticated holder of a token would need a new
   `httpAction` that resolves the token, then streams `ctx.storage.get(storageId)` — the
   pattern exists at `http.ts:143` (RSVP cover) and `http.ts:300` (territory OG card), both
   of which are deliberately public images. **A W9 must NOT follow those; it should be
   readable only through an authenticated staff surface.**

---

## 7. Email

### 7.1 The canonical transactional send

Three layers:

| Layer | File | Role |
|---|---|---|
| Credentials + raw fetch | `lib/resend.ts` | `resolveResendSettings(ctx)` → in-app superuser setting, else `RESEND_API_KEY`/`AUTH_EMAIL_FROM`, else `null`; `sendResendEmail(settings, {to,subject,html})` |
| Convenience | `ticketingEmails.ts:85/105` | `sendEmailReporting(ctx, args): Promise<boolean>` and `sendEmail(ctx, args): Promise<void>` — a missing key is a logged no-op, an HTTP rejection is swallowed, only a transport-level throw escapes |
| Layout | `lib/emailShell.ts` | `emailShell(body, opts?)`, `emailHeading`, `emailSubheading`, `emailParagraph`, `emailButton`, `emailButtonRow`, `emailOutlineButton`, `emailLink`, `emailPanel`, `emailCode`, `emailEyebrow`, `emailRule`, `emailList`, `EMAIL_THEME`/`EMAIL_DARK` |

The rendering package `packages/email-render` + `packages/shared/src/emailRender.ts`,
`emailBlocks.ts`, `emailHtmlDoc.ts`, `tiptapEmail.ts` are for **campaigns** (the Tiptap
newsletter designer), not transactional notices.

**The house pattern is a THREE-PART split**, and every notice in `reimbursements.ts`,
`budgetDecisionEmails.ts`, `campaignApprovalEmails.ts` follows it:

1. A **mutation** that changes state calls `ctx.scheduler.runAfter(0, internal.X.sendYEmail, {id})`.
   *A mutation must never do network I/O, and a Resend hiccup must never fail a committed write.*
2. An **`internalQuery`** that projects the payload (recipients + display fields), returning
   `null` if the row vanished.
3. An **`internalAction`** that renders and sends, **wrapped head-to-toe in try/catch**, with a
   second try/catch **per recipient** so one bad address can't cost the others their mail.

Full worked example (`apps/convex/reimbursements.ts:2989`, trimmed):

```ts
export const sendReimbursementSubmittedEmail = internalAction({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    try {
      const payload = await ctx.runQuery(
        internal.reimbursements.getReimbursementSubmittedEmailPayload, { reimbursementId });
      if (!payload || payload.recipients.length === 0) return null;

      const dollars = `$${(payload.totalCents / 100).toFixed(2)}`;
      const subject = `New reimbursement to review: ${payload.reference} (${dollars})`;
      const link = appUrl("/finances/reimbursements");
      const html = emailShell(`
        ${emailHeading(`Reimbursement ${escapeHtml(payload.reference)}`)}
        ${emailParagraph(`${escapeHtml(payload.payeeName)} submitted a ${escapeHtml(dollars)} reimbursement at ${escapeHtml(payload.chapterName)}. It's waiting on your review.`)}
        ${link ? emailButtonRow(link, "Review it →")
               : emailParagraph("Review it from the Reimbursements tab in the app.", {size:12, margin:"0"})}`);

      for (const email of payload.recipients) {
        try { await sendEmail(ctx, { to: email, subject, html }); }
        catch (err) { console.error("…: recipient send failed", reimbursementId, err); }
      }
    } catch (err) { console.error("sendReimbursementSubmittedEmail: failed", reimbursementId, err); }
    return null;
  },
});
```

Two conventions to carry over:
- **`appUrl(path)` returns `null` when `APP_URL` is unset** — every caller degrades to a
  sentence, never a dead button. `claimantStatusLink()` (`reimbursements.ts:429`) is the
  shared "in-app member → tab / accountless claimant → token page" resolver.
- **Exactly-once email guards are a claimed timestamp on the row.**
  `approvedNoticeSentAt` / `paidNoticeSentAt`, written only by `markApprovedNoticeSent` /
  `markPaidNoticeSent`, which no-op when already set. Both the live path and the backfill
  sweep call the claim mutation FIRST and send only if the claim was theirs.

Escaping: **always `escapeHtml` every interpolated value** (`lib/html.ts`).

### 7.2 Digests / suppression — would anything batch or drop these?

**No, not for transactional finance notices.**

- `emailSuppressions.ts` (unsubscribe / bounce / complaint ledger) is read by
  `audiences.ts`, `campaigns.ts#deliverCampaignBatch`, and `blasts.ts` — the **bulk-mail** path
  only. `sendEmail` / `sendEmailReporting` do **not** consult it.
- `givingNotificationDigests.ts` + `givingNotifications.ts` + `lib/givingNotificationRules.ts`
  are a real digest engine (hourly cron, per-rule claim, `DIGEST_LAG_MS = 60s`), but it is
  **giving-specific**: gift/pledge/backer events only.
- `@supa-media/notifications` contributes `supaNotificationTables` to `schema.ts` (push
  notifications), separate from email.

So a contractor-payment notice will go out immediately, unbatched, and will reach a
suppressed address. If contractor emails should honour suppressions, that is a new decision —
and `emailSuppressions.isSuppressed`-style checks would have to be added at the send site.

---

## 8. Mobile app surface

### 8.1 Structure

```
apps/mobile/app/
  (app)/            ← behind the auth guard
    (tabs)/         ← the 5 bottom tabs: index, people, team, responsibilities, templates, academy
    finances/       ← _layout.tsx (the finance sub-nav) + one file per tab
      index.tsx  reconcile.tsx  receipts.tsx  sales.tsx  budgets.tsx  cards.tsx
      reimbursements/{index.tsx,new.tsx}  repayments.tsx  personal-charges.tsx
      coding.tsx  explain.tsx  publish.tsx  accounts.tsx  book-value.tsx
      my-transactions.tsx  receipt-chase.tsx
  (auth)/
  pay/[token].tsx        ← PUBLIC (outside both groups)
  d/[shareId]            ← PUBLIC doc share
  reimburse-request.tsx  ← sign-in-gated standalone form
```

Styling is **NativeWind v4** (`tailwind.config.js` mirrors `lib/theme.ts` verbatim —
`bg-surface`, `text-ink`, `border-border`). Raw values come from `lib/theme.ts` only where a
runtime value is needed (icon tints, chart fills).

Data fetching is plain `convex/react`: `useQuery(api.x.y, args)`, `useMutation`, `useAction`,
plus `lib/useActionToast.ts#useActionRunner` for the run→toast→error-surface loop, and
`FunctionReturnType<typeof api.x.y>` for row types.

Shared kit: `components/ui/index.ts` exports `Screen`, `Narrow`, `Table`, `TableHeader`,
`HeaderCell`, `Cell`, `Row`, `Badge`, `Button`, `Card`, `Field`, `EmptyState`,
`SectionHeader`, `Icon`, `Pill`, `ToastView`, `DataGrid`, `FilterSelect`, `PersonPicker`,
`DateTimeField`, `FileThumbnail`, `FileViewer`, `CopyButton`, `Checkbox`, `RadioGroup`,
`Switch`, `Popover`, `ContextMenu`, `PageHeader`, `BackLink`…

### 8.2 The 3 best files to copy for a new list + detail + form

1. **`apps/mobile/app/(app)/finances/reimbursements/index.tsx`** (735 lines) — **the single
   best model.** It is *exactly* the screen shape contractor payments needs: a perspective
   switch (finance-seat holder → approval queue; no seat → own requests), section filters
   (`QUEUE_SECTIONS`), expandable rows with line items, the whole action set
   (Approve / Approve subset / Send back with note / Pre-approve / Reject / Pay by ACH),
   `FinanceBoundary` for the permission wall, `useActionRunner` for toasts, and
   `notifyPayoutOutcome()` telling the manager plainly whether the ACH started or degraded to
   manual — "never a fake 'paid'".

2. **`apps/mobile/components/finance/reimbursements/RequestForm.tsx`** (993 lines) +
   **`CodingFields.tsx`** (409 lines) — the multi-line money form with per-line §274(d)
   substantiation, receipt attach, and an event/project "For" picker. Extractable component
   conventions: helpers in a sibling `helpers.ts`, presentational row in `RequestCard.tsx`,
   revise flow in `ReviseForm.tsx`, and a colocated unit test (`queueSections.test.ts`).

3. **`apps/mobile/app/pay/[token].tsx`** — the public, unauthenticated, token-in-the-URL screen.
   Read its header before writing any public screen; it documents the placement rule ("lives
   under `app/` OUTSIDE the `(app)`/`(auth)` route groups, so it is NOT behind the auth guard")
   and the "greets nobody by name" disclosure discipline.

Runner-up for the *detail* half: `app/(app)/finances/cards.tsx` and
`components/finance/dashboard/parts.tsx` (`FinanceBoundary`).

### 8.3 Navigation gating by capability

Two levels.

**(a) Which sub-tabs render** — `apps/mobile/app/(app)/finances/_layout.tsx`:
```ts
const SEAT_TABS: Tab[] = [Dashboard, Book, Receipts, Sales, Budgets, Cards, Reimbursements];
const MEMBER_TABS: Tab[] = [My Card, Reimbursements, Budgets];
const ACCOUNTS_TAB: Tab = { label: "Accounts", path: "/finances/accounts" };
```
The set branches on `api.financeRoles.mySeats` (the caller's REAL finance seats, **not** the
org-chart tier), so a caller with no finance seat never lands on a tab that can only show them
a permission wall. Accounts is a tighter gate on top: `api.financeRoles.canViewAccounts` (ED /
FM only).

That layout file also carries a standing founder directive worth respecting:
**ONE ROW, NO NESTING.** "A tab is a destination. If a future workstream wants a fifth thing
under Cards, the answer is a menu on the Cards page, not a second row here." Contractor
payments should therefore be a **view or menu entry inside Reimbursements**, or a genuinely
new peer chip only if it is genuinely the other direction of money — the same argument that
brought Reimbursements back out of Cards.

**(b) Inside a screen** — `FinanceBoundary`
(`apps/mobile/components/finance/dashboard/parts.tsx`) catches the backend's
`ConvexError({code:"FORBIDDEN"})` and renders the permission wall. The app-wide
`AuthErrorBoundary` does the same at the root. This is why **every backend refusal must be a
`ConvexError({code, message})`, never a plain `Error`.**

---

## 9. Schema, migrations, tests

### 9.1 Schema composition

`apps/convex/schema.ts` is a pure assembly file:
```ts
import { defineSchema } from "convex/server";
import { supaAuthTables, supaNotificationTables } from "@supa-media/convex/schema";
import { chapters, userProfiles, userChapters } from "./schema/chapters";
…
```
Every table is `defineTable(...)` exported from a domain file in `apps/convex/schema/` (39
files, 9,141 lines; `finances.ts` alone is 2,795). **Framework tables come from
`@supa-media/convex/schema` — do not redefine auth or notification tables locally
(upstream-first rule in `CLAUDE.md`).**

Conventions actually enforced by the codebase:
- **Index names spell out every field**: `by_chapter_and_status`, `by_key_and_time`,
  `by_scope_and_seat`, `by_provider_and_event`. Fields must be queried in definition order.
- **`.withIndex()` always; never `.filter()`.**
- **Never `.collect()` on an unbounded table** — `.take(LIMIT)` with a named constant
  (`ROLLUP_SCAN_LIMIT`, `PERSON_SEAT_ASSIGNMENT_LIMIT`, `LINK_CHARGE_LIMIT`,
  `FINANCE_ROLE_SCAN_LIMIT`).
- **Money is always a non-negative INTEGER of cents; direction lives in `flow`, never a sign.**
- **`"central"` is a literal sentinel, never null** —
  `v.union(v.id("chapters"), v.literal("central"))` appears on `transactions.chapterId`,
  `seatAssignments.scope`, `budgets.chapterId`, `increaseAccounts.chapterId`.
- **Enums are shared tuples**, and validators are built from them:
  `v.union(...REIMBURSEMENT_STATUSES.map(s => v.literal(s)))`.
- **A field that must exist is often `v.optional` anyway**, with a comment saying it is
  server-enforced and optional only so pre-existing legacy rows still validate
  (`receiptStorageId`, `transactionDate`, the whole §274(d) block).
- **Doc comments carry the reasoning.** This codebase's schema files are the design record.
  Match that density.

### 9.2 Migrations

`apps/convex/migrations/NNNN_description.ts`, each exporting `{ name, run }` typed as
`Migration`, registered in order in `apps/convex/migrations/index.ts`. The runner
(`migrations.runPending`) walks `MIGRATIONS`, checks the `schemaMigrations` ledger by `name`,
runs and records. **Every `run` must be independently idempotent** — the ledger skip is
belt-and-suspenders.

Not every numbered file is in the registry: some are human-run via `npx convex run` (`0037`,
`0048`), one self-reschedules in batches (`0050`), one is cron-driven (`0052`) because a
`MutationCtx` cannot `fetch`. Sibling file `apps/convex/migrations.ts` holds the historical
bodies + the `runPending` runner.

Best model to copy: `migrations/0069_materialize_reimbursement_receipts.ts` — bounded
(`TXN_SCAN_LIMIT = 5000`), idempotent by construction (short-circuits on existing
`receiptLinks`), returns a `{scanned, created, skipped}` result, and its header states WHY /
WHAT / WHY-SAFE / BOUNDS. Migration tests live alongside the others
(`tests/0062_standardize_powers.test.ts`).

### 9.3 Test setup

`apps/convex/vitest.config.ts`:
```ts
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test", "@convex-dev/aggregate"] } },
    include: ["**/*.test.ts"],
  },
});
```

`apps/convex/tests/setup.helpers.ts` provides:
- `modules = import.meta.glob("../**/*.*s")` — required so `convex-test` resolves `api.*`/`internal.*`.
- `newT()` — `convexTest(schema, modules)` + `registerAggregate(t, "peopleByPersona")`.
- `run(t, fn)` — `t.run` typed with the app's real `MutationCtx` (schema-aware `ctx.db`).
- `setupChapter(t)` — inserts `users` + `chapters` + `userChapters`, returns `{as, userId, chapterId, …}` with an allowed `publicworship.life` email.
- `storeBlob(t)` — a 1×1 blob in file storage, for receipt fixtures.
- `disarmCodingPolicy(t)` — pushes `codingRequiredSinceMs` to 2100 for suites that aren't about coding.

317 test files. The ones to read before writing a contractor-payments suite:
`tests/reimbursements.test.ts`, `tests/reimbursementCoding.test.ts`,
`tests/reimbursementSpend.test.ts`, `tests/reimbursementCodingPort.test.ts`,
`tests/increase.test.ts`, `tests/achLateReturn.test.ts`, `tests/publicLedger.test.ts`.

**A new feature's test would look like this** (the shape `tests/reimbursements.test.ts:56`
establishes — every test needs Increase mocked because every submission creates an External
Account):

```ts
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, storeBlob, type TestConvex } from "./setup.helpers";
import { api, internal } from "../_generated/api";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INCREASE_KEY = process.env.INCREASE_API_KEY;
let extAcctSeq = 0;

function mockIncreaseSuccess(): void {
  process.env.INCREASE_API_KEY = "test_key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/external_accounts")) {
      extAcctSeq += 1;
      return new Response(JSON.stringify({ id: `extacct_auto_${extAcctSeq}` }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.includes("/ach_transfers")) {
      return new Response(JSON.stringify({ id: "ach_1", status: "pending_submission" }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => { mockIncreaseSuccess(); });
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_INCREASE_KEY === undefined) delete process.env.INCREASE_API_KEY;
  else process.env.INCREASE_API_KEY = ORIGINAL_INCREASE_KEY;
});

test("a contractor agreement pays out over ACH and lands on the ledger", async () => {
  const t = newT();
  const s = await setupChapter(t);
  const w9 = await storeBlob(t);
  // 1. staff pre-fills → mint token
  // 2. public: upload W9, link bank, complete → status
  // 3. treasurer approves (SoD: must not be the submitter)
  // 4. pay → assert the /ach_transfers body + Idempotency-Key
  // 5. drive the webhook → assert transactions row flow:"outflow"
  await expect(/* an SoD violation */).rejects.toThrow(ConvexError);
});
```

Run with `pnpm --filter @events-os/convex test` (or `npx vitest run tests/<file>` from
`apps/convex`).

---

## 10. Hard blockers and open decisions for contractor payments

Ordered by how much design work they cost.

### 10.1 ⛔ The payout machine is hard-wired to `reimbursementRequests`

This is the single biggest piece of work.

- `schema/finances.ts:1174` — `payouts.reimbursementId: v.id("reimbursementRequests")` is
  **required and is the idempotency key**, with `by_reimbursement` as the uniqueness index.
- `lib/increasePayoutMachine.ts:47` — `postReimbursementSpend(ctx, chapterId, req: Doc<"reimbursementRequests">, payout)`
  and `settleReimbursementPaid(ctx, req: Doc<"reimbursementRequests">, payout)` take that doc type.
- `transactions.reimbursementId` + the `by_reimbursement` index are the ledger-side
  idempotency key.
- `increasePayouts.beginPayout` reads `reimbursement.status === "approved"`,
  `approvedCents ?? totalCents`, `externalAccountId`, `payeeName`, `personId`.
- `applyPayoutOutcome` patches the reimbursement's status directly.

**Three options, in order of preference:**

1. **Generalize `payouts` to a polymorphic subject** — `subjectType: "reimbursement" |
   "contractor"` + `subjectId: v.string()`, keeping `reimbursementId` optional for back-compat
   (the `approvals` table already uses exactly this `subjectType`/`subjectId` shape). Requires
   a migration and touching `by_reimbursement`, `settleReimbursementPaid`,
   `postReimbursementSpend`, `markPaidManually`, `listPayouts`, and the late-return reversal.
   Highest cost, correct outcome, one payout state machine forever.
2. **A parallel `contractorPayouts` table** reusing `payoutTargetFor` /
   `applyPayoutOutcome`'s *logic* via a small interface. Cheaper, but `onIncreaseWebhookEvent`
   matches by `payouts.by_increase_transfer` and would need to consult two tables — a real
   drift risk on the one path where drift means lost money.
3. **Model a contractor agreement AS a `reimbursementRequest` variant** (add a `kind` field).
   Cheapest by far and everything downstream works untouched — but it overloads a table whose
   entire vocabulary ("claimant", "payee", "receipt", "§274(d) substantiation per line") is
   wrong for a contractor, and the Academy/UI would inherit the confusion.

**Recommendation: option 1**, done as its own PR before the feature lands.

### 10.2 ⚠ No W9 / 1099 / tax-document concept exists

A full-repo grep for `w-9 | w9 | 1099` returns **nothing**. What exists nearby:
- `people.persona` includes `"vendor"` (`schema/people.ts:222`), and
  `people.usualRateUsd` / `companyName` already model a paid vendor.
- `receipts` (`schema/finances.ts:1894`) is a document table with `storageId`, `source`,
  provenance, OCR-seeded canonical fields, and `receiptLinks` — but it is receipt-shaped
  (amount / date / merchant), not identity-document-shaped.

You will need: a place to put the W9 storage id (on the contractor agreement row, or on a new
`contractorProfiles`/`vendorTaxDocuments` table keyed by person), a **read** path that is
staff-only (see §6.2 note 2), a retention/decision on whether a W9 is per-contractor or
per-agreement (per-contractor, almost certainly — nobody re-uploads a W9 per gig), and
explicit content-type/size validation, which no upload path currently performs.

### 10.3 ⚠ Bank-detail storage — the good news, restated as a constraint

There is **no** blocker here, but the invariant is absolute and must be preserved:

> Only the Increase `external_account_id` + a `last4` ever reach Convex. Raw routing/account
> numbers are validated, sent once to Increase, and never persisted or logged.

Enforced in four places: `createExternalAccount` returns only the id + last4;
its error branch logs only response *key names*; `increasePost` suppresses raw bodies for
`/external_accounts`; and `createReimbursement` throws `BANK_REQUIRED` when no
`externalAccountId` is present, making it structurally impossible to write a row with a
half-captured destination.

**Copy the "link first, then write" orchestration exactly** (`reimburseApiRoutes.ts:234`): the
httpAction runs the *action* that creates the External Account, and only then runs the
*mutation* that writes the row. A failed bank link surfaces as a 400 before anything is
written. Do not invent a second path.

Note the one soft edge: `createExternalAccount` **degrades to `null` rather than throwing**
when Increase is unconfigured or fails. The reimbursement flow turns that into an explicit
`BANK_LINK_FAILED` 400. Your flow must do the same, or a contractor will silently end up with
an unpayable agreement.

### 10.4 ⚠ The contractor's name WILL publish on the public ledger

See §4.5. `counterparty` is `displayMerchantName(txn)` frozen at publish, and the only
existing redaction lever (`transactionCodings.publicPurpose`) covers the *purpose* string, not
the counterparty. The gift path proves the mechanism exists (`counterparty: coveredCents > 0 ?
undefined : …`) — but it must be a deliberate decision for contractors, made before the first
month publishes, because **a published statement can only be amended in public.**

### 10.5 ⚠ Two modes = two state machines

"Pre-filled agreement" and "blank request a payment, needs treasurer approval" are different
entry points into what should be **one** status tuple. `REIMBURSEMENT_STATUSES` already solves
the analogous problem with `pending_preapproval` vs `submitted` chosen at creation
(`createReimbursement:1082`) and `PRE_PAYOUT_STATUSES` / `REVIEWABLE_STATUSES` /
`EDITABLE_STATUSES` / `LINKABLE_STATUSES` as four overlapping guard sets. Copy that shape:
**one tuple in `packages/shared/src/finance.ts`, one `assertTransition`, four named
allowed-from sets.**

### 10.6 Smaller notes

- **Rate limiting is mandatory** on every unauthenticated write. Reuse
  `reimbursementSubmitAttempts` with new key prefixes (its schema comment already says it is
  deliberately NOT chapter-scoped, keyed on IP/email). Add the new prefixes to
  `maintenance.sweepRateLimitAttempts`' TTL sweep.
- **Separation of duties is two-layered**: `assertApprovalSoD` (approver ≠ requester) at
  approve, and `assertDisbursementSoD` (payer ≠ payee) at pay. Both compare **`personId` AND
  normalized email** — the email arm is what catches an accountless payee whose roster match
  landed on a different row. Do not implement only one.
- **Transactional email will not be suppressed or batched** (§7.2). If a contractor's address
  bounces, nothing records it against them.
- **`lib/reimbursementReceipts.ts#materializeReimbursementReceipts`** is the model for turning
  a public-page upload into a real `receipts` + `receiptLinks` row at payout time. A W9 is
  probably *not* a `receipts` row (it is not a receipt), but read this before deciding.
- **Per `CLAUDE.md`**: a new capability is a roles/seats change, so
  `packages/shared/src/academy/` and `packages/shared/src/academyPaths.ts` must be updated in
  the same PR, and `apps/convex/lib/seed/templates.ts` capstone quests reference real
  statuses/tabs — run the academy tests after any UI rename.
- **Upstream-first**: nothing in this feature looks generic enough for `supa-framework`, but
  if you find yourself patching `@supa-media/convex`'s schema composables or the `ci.yml`
  workflow, stop and change it upstream.

---

## Appendix — file index

**Public pages / tokens**
`apps/convex/http.ts` · `apps/convex/repaymentLinks.ts` · `apps/convex/lib/repaymentsAccess.ts` ·
`apps/convex/lib/reimbursePage.ts` · `apps/convex/lib/reimburseApiRoutes.ts` ·
`apps/convex/lib/givePage.ts` · `apps/convex/lib/givePageClient.ts` ·
`apps/convex/lib/givePageStyles.ts` · `apps/convex/lib/giveApiRoutes.ts` ·
`apps/convex/lib/projectActionPage.ts` · `apps/convex/lib/pollPage.ts` ·
`apps/convex/lib/unsubscribePage.ts` · `apps/convex/lib/landingPage.ts` ·
`apps/convex/lib/landingPageStyles.ts` · `apps/convex/lib/html.ts` ·
`apps/convex/lib/siteUrl.ts` · `apps/convex/projectActions.ts` ·
`apps/mobile/app/pay/[token].tsx`

**Reimbursements**
`apps/convex/reimbursements.ts` · `apps/convex/lib/reimbursementReceipts.ts` ·
`apps/convex/lib/reimbursementTxnFields.ts` · `apps/convex/lib/reimbursementApprovedEmail.ts` ·
`apps/convex/lib/reimbursementPaidEmail.ts` · `apps/convex/schema/finances.ts`

**Increase / ACH**
`apps/convex/increase.ts` · `apps/convex/increaseAccounts.ts` ·
`apps/convex/increaseExternalAccounts.ts` · `apps/convex/increasePayouts.ts` ·
`apps/convex/increaseProvision.ts` · `apps/convex/increaseLedger.ts` ·
`apps/convex/lib/increaseApi.ts` · `apps/convex/lib/increasePayoutMachine.ts` ·
`apps/convex/lib/increaseShapes.ts` · `apps/convex/webhooks.ts` ·
`apps/convex/financeSettings.ts`

**Coding / budgets / ledger**
`apps/convex/transactionCodings.ts` · `apps/convex/lib/transactionCoding.ts` ·
`apps/convex/lib/transactionCodingAccess.ts` · `packages/shared/src/finance.ts` ·
`apps/convex/budgetLines.ts` · `apps/convex/publicLedger.ts` ·
`apps/convex/schema/publicLedger.ts` · `packages/shared/src/publicLedger.ts` ·
`apps/convex/lib/publicLedgerAccess.ts` · `apps/convex/lib/publicLedgerSnapshot.ts` ·
`apps/convex/lib/publicLedgerPage.ts` · `apps/convex/lib/publicLedgerCsv.ts` ·
`apps/convex/lib/giftCoverage.ts` · `apps/convex/publishability.ts` ·
`apps/convex/lib/publishabilityAccess.ts`

**Access control**
`packages/shared/src/seats.ts` · `packages/shared/src/powers.ts` ·
`packages/shared/src/academyPaths.ts` · `apps/convex/schema/seats.ts` ·
`apps/convex/lib/finance.ts` · `apps/convex/lib/seats.ts` ·
`apps/convex/lib/seatStructure.ts` · `apps/convex/lib/campaignsAccess.ts` ·
`apps/convex/lib/givingAccess.ts` · `apps/convex/lib/superuser.ts` ·
`apps/convex/lib/context.ts` · `apps/convex/lib/access.ts`

**Uploads / email**
`apps/convex/storage.ts` · `apps/convex/receipts.ts` · `apps/convex/lib/resend.ts` ·
`apps/convex/lib/emailShell.ts` · `apps/convex/ticketingEmails.ts` ·
`apps/convex/budgetDecisionEmails.ts` · `apps/convex/campaignApprovalEmails.ts` ·
`apps/convex/emailSuppressions.ts` · `packages/email-render`

**Mobile**
`apps/mobile/app/(app)/finances/_layout.tsx` ·
`apps/mobile/app/(app)/finances/reimbursements/index.tsx` ·
`apps/mobile/components/finance/reimbursements/{RequestForm,CodingFields,RequestCard,ReviseForm,HowItWorks}.tsx` ·
`apps/mobile/components/finance/reimbursements/helpers.ts` ·
`apps/mobile/components/finance/dashboard/parts.tsx` ·
`apps/mobile/components/ui/index.ts` · `apps/mobile/lib/theme.ts` ·
`apps/mobile/lib/useActionToast.ts` · `apps/mobile/lib/appUrl.ts`

**Schema / tests / migrations**
`apps/convex/schema.ts` · `apps/convex/schema/` · `apps/convex/migrations/index.ts` ·
`apps/convex/migrations.ts` · `apps/convex/vitest.config.ts` ·
`apps/convex/tests/setup.helpers.ts` · `apps/convex/tests/reimbursements.test.ts` ·
`apps/convex/tests/achLateReturn.test.ts` · `apps/convex/tests/increase.test.ts`

**Docs worth reading before implementing**
`docs/plans/finance.md` · `docs/plans/transaction-coding.md` · `docs/plans/public-ledger.md` ·
`docs/plans/receipt-exceptions.md` · `docs/plans/url-consolidation.md`
