/**
 * Increase — the native money layer for Chapter OS (Phase 4: ACH reimbursement
 * payouts + the chapter's bank Account).
 *
 * Increase is the source of truth for a chapter's balance: one shared org Entity
 * (`INCREASE_ENTITY_ID`); one Account per chapter (`increaseAccounts`), member
 * cards issued on it (Phase 5), and ACH reimbursement payouts (`payouts`)
 * originating from it. NO Stripe Issuing / Connect — Stripe FC
 * (`stripeFinance.ts`) only *reads* legacy accounts.
 *
 * DESIGN (mirrors `stripeFinance.ts`): the network fetch is separated from the
 * DB apply so the payout state machine is testable WITHOUT hitting Increase.
 * Actions FETCH (raw `fetch`, no SDK); internal mutations APPLY against
 * `ctx.db`. The webhook state machine (`onIncreaseWebhookEvent`) is a pure
 * internal mutation the orchestrator's `/increase/webhook` route fans events
 * into after `verifyIncreaseSignature`.
 *
 * INVARIANTS:
 *  - Money is ALWAYS a non-negative INTEGER number of cents; direction lives in
 *    `transactions.flow`, never a sign.
 *  - Every table is chapter-scoped; every client id is verified in the caller's
 *    chapter before use.
 *  - Reimbursement payouts post as `flow:"transfer"` → EXCLUDED from category /
 *    budget spend (the underlying expense was already booked on the line item;
 *    counting the transfer too would double-count).
 *  - `payouts` is idempotency-keyed on `reimbursementId`: at most one LIVE payout
 *    per reimbursement, so an approved reimbursement can NEVER double-pay.
 *  - Degrade to a logged no-op (never throw) when `INCREASE_API_KEY` is unset.
 *  - All failures throw `ConvexError` (never a plain `Error`).
 *
 * ACH DESTINATION CAPTURE: the reimbursement form (public + in-app) links a
 * REAL bank account via `linkPublicBankAccount` / `linkBankAccount`
 * (`reimbursements.ts`), which create an Increase External Account (`POST
 * /external_accounts` — `createExternalAccount` below) and store only its
 * reusable reference id (`reimbursementRequests.externalAccountId`) + a
 * last-4 for display — the raw routing + account number are NEVER persisted.
 * `beginPayout` only takes the real ACH branch once that id is present
 * (`hasFullDestination`); absent it, `payReimbursement` DEGRADES to a
 * `provider:"manual"`, `pending` payout and steers the manager to
 * `markPaidManually` (the working Phase-4 fallback) — so an unlinked
 * reimbursement is never blocked, just paid by hand.
 *
 * Env: INCREASE_API_KEY, INCREASE_WEBHOOK_SECRET, INCREASE_ENTITY_ID (the shared
 * org Entity) — all required. INCREASE_PROGRAM_ID is an OPTIONAL override; the
 * Program is auto-resolved from `GET /programs` (a nonprofit has exactly one).
 * INCREASE_API_BASE is the sandbox URL for dev/staging (defaults to production).
 * INCREASE_SANDBOX_API_KEY (OPTIONAL): lets the single prod `/increase/webhook`
 * endpoint also serve sandbox webhooks — follow-up calls about a `sandbox_`-
 * prefixed object are routed to the sandbox with this key (see
 * `increaseEnvForObjectId`).
 */
import {
  action,
  mutation,
  query,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { MutationCtx, QueryCtx, ActionCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  PAYOUT_PROVIDERS,
  PAYOUT_STATUSES,
  INCREASE_ONBOARDING_STATUSES,
  EXTERNAL_ACCOUNT_FUNDINGS,
  isSandboxObjectId,
  matchesMode,
  type PayoutProvider,
  type PayoutStatus,
} from "@events-os/shared";
import { readSandbox } from "./financeSettings";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import { normalizeEmail, getUserEmail } from "./lib/access";
import {
  requireFinanceRole,
  requireFinanceManager,
  resolveCallerPersonId,
  assertSeparationOfDuties,
  getChapterAccountForMode,
  defaultFundId,
  requireCentralEdOrFm,
  type FinanceScope,
} from "./lib/finance";
import { queueSuggestionOnIngest } from "./aiCodingData";

/** The org level's own Increase account (WP-1.2) — where the City Launch Fund
 *  lives (feeds the future skim destination). Named for the org, not a
 *  generic "Central", so it reads clearly next to chapter account names in
 *  the match-before-create list. */
const CENTRAL_ACCOUNT_NAME = "Public Worship — Central";

/** Increase API base URL. Env-overridable so dev/staging point at the sandbox
 *  (`INCREASE_API_BASE=https://sandbox.increase.com`); defaults to production. */
function increaseApiBase(): string {
  return process.env.INCREASE_API_BASE ?? "https://api.increase.com";
}

/**
 * Resolve which Increase environment (API key + base URL) a follow-up call about
 * a given object should use. ONE `/increase/webhook` endpoint (on the prod
 * deployment) safely serves BOTH production and sandbox Increase webhooks: a
 * sandbox object's id is prefixed `sandbox_`, so the follow-up fetch is routed to
 * the sandbox with `INCREASE_SANDBOX_API_KEY`; a production object uses the
 * deployment's own `INCREASE_API_KEY` + base. `key` may be undefined (the
 * environment isn't wired up) — the caller degrades to a logged no-op.
 */
export function increaseEnvForObjectId(objectId: string): {
  key: string | undefined;
  base: string;
} {
  if (objectId.startsWith("sandbox_")) {
    return {
      key: process.env.INCREASE_SANDBOX_API_KEY,
      base: "https://sandbox.increase.com",
    };
  }
  return { key: process.env.INCREASE_API_KEY, base: increaseApiBase() };
}

/**
 * Resolve which Increase environment (API key + base URL + shared org Entity) to
 * open a NEW account in, given the runtime sandbox toggle (`financeSettings`).
 * The mirror of `increaseEnvForObjectId` for the provisioning side: a
 * sandbox-provisioned account's id comes back prefixed `sandbox_`, so it later
 * self-identifies via `increaseEnvForObjectId`. `key`/`entityId` may be undefined
 * (that environment isn't wired up) — the caller degrades to `pending`.
 */
export function increaseEnvForMode(sandbox: boolean): {
  key: string | undefined;
  base: string;
  entityId: string | undefined;
  // Per-mode Program override. MUST be mode-scoped: the prod
  // `INCREASE_PROGRAM_ID` is a PROD program id and would be rejected by the
  // sandbox API, so sandbox uses its own (usually-unset) override → auto-resolve.
  programOverride: string | undefined;
} {
  if (sandbox) {
    return {
      key: process.env.INCREASE_SANDBOX_API_KEY,
      base: "https://sandbox.increase.com",
      entityId: process.env.INCREASE_SANDBOX_ENTITY_ID,
      programOverride: process.env.INCREASE_SANDBOX_PROGRAM_ID,
    };
  }
  return {
    key: process.env.INCREASE_API_KEY,
    base: increaseApiBase(),
    entityId: process.env.INCREASE_ENTITY_ID,
    programOverride: process.env.INCREASE_PROGRAM_ID,
  };
}

/** Payouts that block a re-pay (money is in motion or already out the door).
 *  `failed` / `returned` / `canceled` are NOT live — a fresh payout may follow. */
const LIVE_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  "pending",
  "processing",
  "paid",
];

/** Reject a non-positive payout amount. Guards the `0 ?? x === 0` trap: a
 *  reimbursement approved with zero lines has `approvedCents === 0`, which would
 *  otherwise mint a $0 payout + $0 `transfer` marked paid. */
function assertPositivePayout(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message:
        "A reimbursement payout must be a positive whole number of cents.",
    });
  }
}

/**
 * Disbursement separation of duties: the person RELEASING a payout must not be
 * the payee. Mirrors the approval-side SoD (`reimbursements.ts`) with two
 * independent signals so it can't be sidestepped:
 *   - the roster link: the caller's person is the request's linked payee, OR
 *   - the email: the caller's auth email equals the request's `payeeEmail`
 *     (case-insensitive) — catches an unlinked self-submission.
 */
function assertDisbursementSoD(
  callerPersonId: Id<"people">,
  callerEmail: string | null,
  req: Doc<"reimbursementRequests">,
): void {
  assertSeparationOfDuties(callerPersonId, req.personId);
  const payer = normalizeEmail(callerEmail);
  const payee = normalizeEmail(req.payeeEmail);
  if (payer && payee && payer === payee) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message:
        "The person releasing a payout must be different from the payee.",
    });
  }
}

// ── Validators ────────────────────────────────────────────────────────────────

const onboardingValidator = v.union(
  ...INCREASE_ONBOARDING_STATUSES.map((s) => v.literal(s)),
);
const payoutProviderValidator = v.union(
  ...PAYOUT_PROVIDERS.map((p) => v.literal(p)),
);
const payoutStatusValidator = v.union(
  ...PAYOUT_STATUSES.map((s) => v.literal(s)),
);

/** The read shape the UI renders for a payout (also every action's return). */
const payoutSummaryValidator = v.object({
  id: v.id("payouts"),
  reimbursementId: v.id("reimbursementRequests"),
  payeePersonId: v.union(v.id("people"), v.null()),
  amountCents: v.number(),
  provider: payoutProviderValidator,
  status: payoutStatusValidator,
  increaseTransferId: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

const financeScopeValidator = v.union(v.id("chapters"), v.literal("central"));

const increaseAccountSummaryValidator = v.object({
  id: v.id("increaseAccounts"),
  chapterId: financeScopeValidator,
  increaseEntityId: v.union(v.string(), v.null()),
  increaseAccountId: v.union(v.string(), v.null()),
  onboardingStatus: onboardingValidator,
});

// ── TS shapes (for action ↔ internal-mutation typing) ────────────────────────

interface PayoutSummary {
  id: Id<"payouts">;
  reimbursementId: Id<"reimbursementRequests">;
  payeePersonId: Id<"people"> | null;
  amountCents: number;
  provider: PayoutProvider;
  status: PayoutStatus;
  increaseTransferId: string | null;
  createdAt: number;
}

interface IncreaseAccountSummary {
  id: Id<"increaseAccounts">;
  chapterId: FinanceScope;
  increaseEntityId: string | null;
  increaseAccountId: string | null;
  onboardingStatus: (typeof INCREASE_ONBOARDING_STATUSES)[number];
}

type BeginPayoutResult =
  | { kind: "existing"; payout: PayoutSummary }
  | { kind: "manual"; payout: PayoutSummary }
  | {
      kind: "increase";
      payoutId: Id<"payouts">;
      increaseAccountId: string;
      amountCents: number;
      reimbursementId: Id<"reimbursementRequests">;
      // ACH destination (whichever exists): the reimbursement's linked Increase
      // External Account (`reimbursementRequests.externalAccountId`, captured
      // via `linkPublicBankAccount` / `linkBankAccount`), OR raw routing +
      // account (+ funding) — currently always null; kept for forward-compat
      // with a future raw-details capture path. `beginPayout` only takes this
      // branch when `hasFullDestination` is true, so `payReimbursement` always
      // has something here to address the transfer with.
      externalAccountId: string | null;
      accountNumber: string | null;
      routingNumber: string | null;
      funding: "checking" | "savings" | null;
    };

type BeginProvisionResult =
  | { kind: "existing"; account: IncreaseAccountSummary }
  | {
      kind: "provision";
      accountId: Id<"increaseAccounts">;
      chapterId: FinanceScope;
      chapterName: string;
    };

function toPayoutSummary(p: Doc<"payouts">): PayoutSummary {
  return {
    id: p._id,
    reimbursementId: p.reimbursementId,
    payeePersonId: p.payeePersonId ?? null,
    amountCents: p.amountCents,
    provider: p.provider,
    status: p.status,
    increaseTransferId: p.increaseTransferId ?? null,
    createdAt: p.createdAt,
  };
}

function toAccountSummary(a: Doc<"increaseAccounts">): IncreaseAccountSummary {
  return {
    id: a._id,
    chapterId: a.chapterId,
    increaseEntityId: a.increaseEntityId ?? null,
    increaseAccountId: a.increaseAccountId ?? null,
    onboardingStatus: a.onboardingStatus,
  };
}

// ── Raw Increase fetch helpers (default runtime `fetch`, no SDK) ──────────────

/**
 * Build a diagnostic suffix from an Increase error HTTP response: the status
 * code plus, when the body is Increase's JSON error shape
 * (`{type, title, detail}`), its `title`/`detail`. Parsed DEFENSIVELY — the body
 * may not be JSON (proxy/HTML error pages), in which case the status stands
 * alone. NEVER includes the API key or Authorization header — only the status
 * and the server-provided error text. Example: `HTTP 401: API key is invalid`.
 */
function describeIncreaseError(status: number, bodyText: string): string {
  let title: string | undefined;
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as {
      title?: unknown;
      detail?: unknown;
    };
    if (typeof parsed.title === "string" && parsed.title) title = parsed.title;
    if (typeof parsed.detail === "string" && parsed.detail)
      detail = parsed.detail;
  } catch {
    // Non-JSON body (e.g. an HTML error page) — the status alone is the signal.
  }
  const suffix = [title, detail].filter(Boolean).join(": ");
  return suffix ? `HTTP ${status}: ${suffix}` : `HTTP ${status}`;
}

/** POST JSON to the Increase API. `idempotencyKey` sets the `Idempotency-Key`
 *  header so a retried request never creates a second transfer. Throws
 *  ConvexError on a non-2xx (the caller logs + degrades). */
async function increasePost(
  key: string,
  base: string,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    // `/external_accounts` error bodies can ECHO the submitted account/routing
    // digits — never log that raw. Log only the status + Increase's error text
    // (`describeIncreaseError` parses `title`/`detail`, never the raw body).
    const sensitive = path.includes("/external_accounts");
    console.error(
      `[increase] POST ${path} failed:`,
      sensitive ? describeIncreaseError(res.status, bodyText) : bodyText,
    );
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `The Increase request failed (${describeIncreaseError(res.status, bodyText)}).`,
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

/** GET JSON from the Increase API. Increase webhook events carry NO inline
 *  object — only `associated_object_id` — so status/details are read by FETCHING
 *  the object (e.g. GET /ach_transfers/{id}). Throws ConvexError on a non-2xx. */
async function increaseGet(
  key: string,
  base: string,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error(`[increase] GET ${path} failed:`, bodyText);
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `The Increase request failed (${describeIncreaseError(res.status, bodyText)}).`,
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

/** PATCH JSON to the Increase API (e.g. `PATCH /cards/{id}` to attach a
 *  Digital Card Profile — WP-C.2's `backfillCardProfiles`). A private mirror of
 *  `cards.ts`'s own `increasePatch` — this file already duplicates `increaseGet`
 *  rather than share across files, so this follows the same precedent. Throws
 *  ConvexError on a non-2xx (the caller logs + degrades). */
async function increasePatch(
  key: string,
  base: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error(`[increase] PATCH ${path} failed:`, bodyText);
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `The Increase request failed (${describeIncreaseError(res.status, bodyText)}).`,
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

/** The two `POST /files` `purpose` values WP-C.2 uses — grounded against
 *  `increase-typescript`'s `Files` resource (the full `purpose` enum also
 *  covers check images, statements, etc.; these are the only two relevant to
 *  Digital Wallet card art). */
type CardArtFilePurpose = "digital_wallet_artwork" | "digital_wallet_app_icon";

/** CRLF is required between every multipart line/part per RFC 7578 — a bare
 *  `\n` is rejected by strict multipart parsers. Named so every literal below
 *  reads as "the multipart line ending", not a stray escape sequence. */
const CRLF = "\r\n";

/**
 * Hand-build a `multipart/form-data` request body as a `Uint8Array` — one
 * binary file field plus any number of string fields, RFC 7578-correct
 * (CRLF between every line, a blank CRLF line ending each part's headers,
 * `--{boundary}--` + CRLF as the closing delimiter).
 *
 * This exists ONLY because `FormData`/`Blob` are DOM constructs that are
 * unverified in Convex's default (non-Node) action runtime — tests import
 * Node and would pass even if they silently didn't exist live, the exact
 * "green CI, breaks live" class of bug ADR-013 documents for mobile native
 * rendering. Building the body from `TextEncoder` + `Uint8Array` concatenation
 * uses only primitives the isolate guarantees, so there's nothing left to
 * verify at runtime — the byte layout is asserted directly by
 * `tests/cardArtProfile.test.ts`.
 */
function buildMultipartFormData(
  boundary: string,
  fields: Record<string, string>,
  file: {
    fieldName: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array<ArrayBuffer>;
  },
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const pushText = (s: string) => chunks.push(encoder.encode(s));

  for (const [name, value] of Object.entries(fields)) {
    pushText(`--${boundary}${CRLF}`);
    pushText(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`);
    pushText(`${value}${CRLF}`);
  }

  pushText(`--${boundary}${CRLF}`);
  pushText(
    `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"${CRLF}`,
  );
  pushText(`Content-Type: ${file.contentType}${CRLF}${CRLF}`);
  chunks.push(file.bytes);
  pushText(CRLF);

  pushText(`--${boundary}--${CRLF}`);

  const length = chunks.reduce((sum, c) => sum + c.length, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return body;
}

/**
 * Upload one base64-encoded PNG to Increase's Files API (WP-C.2 card art).
 * `POST /files` is the one Increase endpoint that ISN'T JSON — it requires
 * `multipart/form-data` (confirmed against the Increase docs). The body is
 * built BY HAND via `buildMultipartFormData` (no `FormData`/`Blob` — see its
 * doc comment) with an explicit `Content-Type: multipart/form-data;
 * boundary=...` header; `fetch` does not compute a boundary for a raw
 * `Uint8Array` body the way it would for `FormData`, so the header must name
 * the exact boundary used to build the body.
 *
 * Rejects a `data:` URI prefix defensively (`uploadCardArtAssets`'s docstring
 * requires raw base64, but a caller pasting straight from a browser file
 * picker easily includes it) rather than silently uploading a corrupt PNG.
 * Throws ConvexError on a non-2xx or a response with no usable file id.
 */
async function increasePostFile(
  key: string,
  base: string,
  base64Png: string,
  filename: string,
  purpose: CardArtFilePurpose,
): Promise<string> {
  if (base64Png.startsWith("data:")) {
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `Card art must be raw base64 (no "data:" URI prefix) — got one for the "${purpose}" upload.`,
    });
  }
  const boundary = `----ConvexFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const body = buildMultipartFormData(
    boundary,
    { purpose },
    { fieldName: "file", filename, contentType: "image/png", bytes: base64ToBytes(base64Png) },
  );
  const res = await fetch(`${base}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error(`[increase] POST /files (${purpose}) failed:`, bodyText);
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `The Increase file upload failed (${describeIncreaseError(res.status, bodyText)}).`,
    });
  }
  const responseBody = (await res.json()) as { id?: unknown };
  if (typeof responseBody.id !== "string" || !responseBody.id) {
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `The Increase file upload (${purpose}) returned no usable file id.`,
    });
  }
  return responseBody.id;
}

/** Resolve the Increase Program id to open a chapter Account under.
 *  `INCREASE_PROGRAM_ID` is an OPTIONAL explicit override — set it and it wins.
 *  Otherwise we fetch `GET /programs` and use the SOLE program, because a
 *  nonprofit has exactly ONE Increase Program (confirmed against both the live
 *  sandbox and production). Returns null (never throws) when there is no override
 *  AND `/programs` doesn't return exactly one program (0 or >1 → a clear warning),
 *  or on any fetch/parse error — the caller degrades to `pending`. The `base`
 *  is threaded through so a SANDBOX key hits the sandbox `/programs`. */
async function resolveProgramId(
  key: string,
  base: string,
  override: string | undefined,
): Promise<string | null> {
  // The override MUST be the one for THIS environment (see increaseEnvForMode) —
  // reading a global INCREASE_PROGRAM_ID here would leak the prod program into a
  // sandbox account creation and be rejected.
  if (override) return override;
  try {
    const res = await fetch(`${base}/programs`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.error("[increase] GET /programs failed:", await res.text());
      return null;
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const programs = body.data ?? [];
    if (programs.length !== 1 || !programs[0]?.id) {
      console.warn(
        `[increase] expected exactly one Increase Program; set INCREASE_PROGRAM_ID (found ${programs.length})`,
      );
      return null;
    }
    return programs[0].id;
  } catch (err) {
    console.error("[increase] failed to resolve Increase Program:", err);
    return null;
  }
}

/** Normalize an Increase account / chapter name for comparison: trimmed +
 *  lowercased. Whitespace-insensitive on the ends, case-insensitive throughout. */
function normalizeAccountName(name: string): string {
  return name.trim().toLowerCase();
}

/** The subset of an Increase Account object we read when matching by name. */
interface IncreaseAccountLite {
  id?: string;
  name?: string;
  status?: string;
}

/**
 * Decide whether the org Entity already holds an Account that should be LINKED to
 * this chapter instead of creating a duplicate. Increase accounts are listed via
 * `GET /accounts?entity_id=...`; if one is already named for the chapter (the
 * nonprofit opened it by hand in the Increase dashboard), we adopt it rather than
 * open a second account under the same name.
 *
 * Matching is case-insensitive + end-trimmed. For a CHAPTER it's deliberately
 * fuzzy: an EXACT normalized-equality OR either name CONTAINING the other
 * counts (so an Increase account named "New York" matches a chapter "The New
 * York Chapter", and vice versa) — adopting a hand-named account is the whole
 * point there. When several accounts match, an EXACT normalized-name match
 * always wins — and if several accounts share the exact chapter name (e.g.
 * earlier duplicate "The New York Chapter" rows a buggy retry created), we
 * link the FIRST exact one rather than open yet another duplicate. We only
 * return null (caller creates fresh) when there's NO exact match and several
 * names merely loosely overlap — there we won't guess the wrong existing
 * account.
 *
 * For CENTRAL, fuzzy substring matching is unsafe: the org's pre-existing prod
 * Increase account is very likely to be named something plain like the
 * nonprofit's own name (e.g. "Public Worship"), which is a SUBSTRING of
 * `CENTRAL_ACCOUNT_NAME` ("Public Worship — Central") and would otherwise get
 * silently adopted as the City Launch Fund's home — the wrong account. So
 * `exactOnly` restricts central to normalized-equality only; a bare "Public
 * Worship" account is ignored and a fresh central account is created instead.
 */
function pickMatchingAccount(
  accounts: IncreaseAccountLite[],
  chapterName: string,
  exactOnly: boolean,
): { id: string; name: string } | null {
  const target = normalizeAccountName(chapterName);
  if (!target) return null;

  const named = accounts.filter(
    (a): a is { id: string; name: string; status?: string } =>
      typeof a.id === "string" && typeof a.name === "string",
  );
  const matches = named.filter((a) => {
    const n = normalizeAccountName(a.name);
    if (!n) return false;
    if (exactOnly) return n === target;
    return n === target || n.includes(target) || target.includes(n);
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };

  // Several match → an EXACT normalized-name match always wins. Multiple exact
  // matches are duplicate accounts under the same name (what the prod retry bug
  // produced) — link the FIRST rather than mint another duplicate.
  const exact = matches.filter((a) => normalizeAccountName(a.name) === target);
  if (exact.length >= 1) return { id: exact[0].id, name: exact[0].name };

  // No exact match, only loose overlaps → don't guess wrong; caller creates one.
  console.warn(
    `[increase] provision: ${matches.length} accounts loosely match chapter "${chapterName}" with no exact match — creating a new account rather than linking the wrong one`,
  );
  return null;
}

// ── ACH destination capture (Increase External Accounts) ─────────────────────

const externalAccountFundingValidator = v.union(
  ...EXTERNAL_ACCOUNT_FUNDINGS.map((f) => v.literal(f)),
);

/** Normalize + validate a routing number: exactly 9 digits (the ABA RTN
 *  length Increase's `POST /external_accounts.routing_number` expects). Throws
 *  `ConvexError` — never persists / logs the value itself. */
export function assertRoutingNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 9) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Routing number must be exactly 9 digits.",
    });
  }
  return digits;
}

/** Normalize + validate a bank account number: digits only, 4–17 characters
 *  (Increase's own bound on `account_number` is 1–17; we require at least 4 so
 *  a last-4 is always meaningful). Throws `ConvexError`. */
export function assertAccountNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4 || digits.length > 17) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Account number must be between 4 and 17 digits.",
    });
  }
  return digits;
}

/**
 * Create an Increase External Account (`POST /external_accounts`) — the
 * reusable destination-bank primitive Increase's own API models, rather than
 * ever sending a raw routing+account pair inline on every transfer. Grounded
 * against the real Increase docs (increase.com/documentation/api/external-accounts):
 * required `account_number` + `routing_number` + `description`; optional
 * `account_holder` (business/individual/unknown) + `funding` (defaults
 * `checking`). External Accounts are NOT associated with an `entity_id` or
 * `account_id` — they're a standalone, reusable bank-details object referenced
 * later by id (`external_account_id`) on an ACH transfer.
 *
 * MODE-AWARE like the rest of this file: uses the CURRENT
 * `financeSettings.sandboxMode` toggle (`increaseEnvForMode`) — the same
 * environment a chapter's own Increase Account is provisioned in — so a
 * destination captured now lines up with whichever environment
 * `payReimbursement` / `initiateRepayment` will later address (both self-select
 * their env from the CHAPTER's account id prefix, itself stamped from this same
 * toggle at provision time). An External Account created in sandbox comes back
 * `sandbox_`-prefixed, same as every other Increase object here.
 *
 * DEGRADES to `null` (never throws) when the mode's API key is unset or the
 * Increase call fails — the caller leaves the reimbursement/repayment
 * unlinked, so its payout just falls back to the manual/degraded path. The raw
 * account number is used only for this one request; nothing here persists it —
 * the caller stores just the returned id + a last-4 for display.
 */
export const createExternalAccount = internalAction({
  args: {
    routingNumber: v.string(),
    accountNumber: v.string(),
    accountHolderName: v.string(),
    funding: externalAccountFundingValidator,
  },
  returns: v.union(
    v.object({ externalAccountId: v.string(), last4: v.string() }),
    v.null(),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{ externalAccountId: string; last4: string } | null> => {
    const sandboxMode = await ctx.runQuery(
      internal.financeSettings.readSandboxMode,
      {},
    );
    const { key, base } = increaseEnvForMode(sandboxMode);
    if (!key) {
      console.warn(
        "[increase] external account link skipped: Increase API key not configured for this environment",
      );
      return null;
    }
    try {
      // Deliberately NO `Idempotency-Key` here (unlike `/accounts` and
      // `/ach_transfers` elsewhere in this file): the natural key would be the
      // reimbursement/repayment id, but a person legitimately changing their
      // bank details mid-request must get a FRESH External Account for the
      // NEW numbers — reusing a stable key would make Increase silently
      // return the FIRST (now-stale) object instead, addressing money to the
      // wrong account. This call only ever runs once per user click (no
      // scheduler retry sits behind it), so the duplicate-on-retry risk an
      // idempotency key guards against elsewhere doesn't apply the same way.
      const account = await increasePost(key, base, "/external_accounts", {
        routing_number: args.routingNumber,
        account_number: args.accountNumber,
        description: args.accountHolderName.slice(0, 200) || "Reimbursement payee",
        account_holder: "individual",
        funding: args.funding,
      });
      const externalAccountId =
        typeof account.id === "string" && account.id ? account.id : null;
      if (!externalAccountId) {
        // Deliberately NOT logging the response body: Increase's External
        // Account object echoes back the full `account_number` /
        // `routing_number`, which must never land in logs.
        console.error(
          "[increase] external account create returned no usable id (response keys:",
          Object.keys(account ?? {}).join(","),
          ")",
        );
        return null;
      }
      return { externalAccountId, last4: args.accountNumber.slice(-4) };
    } catch (err) {
      console.error("[increase] failed to create external account:", err);
      return null;
    }
  },
});

// ── Payout state-machine helpers (pure DB, the testable core) ────────────────

/** The single `transfer`-flow transaction recording a reimbursement payout
 *  leaving the account. IDEMPOTENT: at most one per reimbursement (keyed via
 *  the `by_reimbursement` index). Positive integer cents; `flow:"transfer"` so
 *  it's excluded from category/budget spend. Links the payout to the txn. */
async function postReimbursementTransfer(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  req: Doc<"reimbursementRequests">,
  payout: Doc<"payouts">,
): Promise<Id<"transactions">> {
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
    .first();
  if (existing) {
    if (!payout.transactionId) {
      await ctx.db.patch(payout._id, {
        transactionId: existing._id,
        updatedAt: Date.now(),
      });
    }
    return existing._id;
  }
  const now = Date.now();
  const txnId = await ctx.db.insert("transactions", {
    chapterId,
    source: "reimbursement",
    flow: "transfer", // EXCLUDED from category/budget spend (anti-double-count)
    amountCents: payout.amountCents,
    currency: "usd",
    postedAt: now,
    personId: req.personId,
    reimbursementId: req._id,
    status: "reconciled",
    createdAt: now,
  });
  await ctx.db.patch(payout._id, { transactionId: txnId, updatedAt: now });
  return txnId;
}

/** Settle a payout: mark the reimbursement `paid` + post the offsetting
 *  `transfer` ledger row. Idempotent via `postReimbursementTransfer`. */
async function settleReimbursementPaid(
  ctx: MutationCtx,
  req: Doc<"reimbursementRequests">,
  payout: Doc<"payouts">,
): Promise<void> {
  const now = Date.now();
  if (req.status !== "paid") {
    await ctx.db.patch(req._id, {
      status: "paid",
      paidAt: req.paidAt ?? now,
      payoutId: payout._id,
      updatedAt: now,
    });
  }
  await postReimbursementTransfer(ctx, req.chapterId, req, payout);
}

/** The payout status an inbound Increase ACH-transfer maps to (or null = ignore).
 *
 * Increase webhook events carry no inline status — `handleIncreaseWebhook`
 * FETCHES the ACH transfer (GET /ach_transfers/{id}) and passes its real
 * `status` here alongside the event `category` (`ach_transfer.created` /
 * `.updated`). Real Increase ACH-transfer statuses (there is NO post-settlement
 * "settled"/"paid" status — an outbound CREDIT is irrevocably sent at
 * `submitted`, so that IS our terminal "paid"; a `returned` may arrive days
 * later):
 *   - `returned`                                              → returned
 *   - `rejected` / `canceled`                                 → failed
 *   - `submitted`                                             → paid
 *   - `pending_approval` / `pending_submission` /
 *     `pending_reviewing` / `pending_transfer_session_confirmation`
 *                                                             → processing
 *   - `requires_attention` (and anything unrecognized)        → null (no change;
 *     a human investigates — never auto-fail or auto-pay it).
 * `settled`/`paid` stay accepted (harmless) for forward-compat. */
type PayoutTarget = "processing" | "paid" | "failed" | "returned";
function payoutTargetFor(
  eventType: string,
  status?: string,
): PayoutTarget | null {
  const s = (status ?? "").toLowerCase();
  const e = eventType.toLowerCase();
  if (s === "returned" || e.includes("returned")) return "returned";
  if (
    ["failed", "rejected", "canceled", "declined"].includes(s) ||
    e.includes("failed") ||
    e.includes("rejected") ||
    e.includes("canceled")
  ) {
    return "failed";
  }
  // `submitted` = the CREDIT has been sent to the network (Increase's terminal
  // success for an ACH credit — there is no later "settled" event).
  if (
    ["submitted", "settled", "complete", "completed", "paid"].includes(s) ||
    e.includes("settled") ||
    e.includes("submitted") ||
    e.includes("paid")
  ) {
    return "paid";
  }
  // `requires_attention` means a human must act in the Increase dashboard — do
  // NOT auto-advance the payout (leave it where it is), even though the carrier
  // event is `ach_transfer.updated`.
  if (s === "requires_attention") return null;
  if (s.startsWith("pending") || ["created", "processing"].includes(s)) {
    return "processing";
  }
  // No fetched status (or an `ach_transfer.created`/`.updated` we can't classify
  // yet): treat a bare lifecycle event as still in-flight.
  if (e.includes("created") || e.includes("updated")) return "processing";
  return null;
}

/**
 * Reverse an already-`paid` payout whose ACH credit bounced (`returned`) DAYS
 * after Increase reported `submitted` (there is no post-settlement "settled"
 * event for an ACH credit — `submitted` IS our terminal `paid`, so a return is
 * the only signal that can still arrive after the fact). Re-opens the
 * reimbursement to `approved` so a manager can retry or investigate, and
 * REMOVES the offsetting `transfer` ledger row this payout posted.
 *
 * Deleting (rather than merely re-flagging) the transaction is deliberate and
 * safe: `transfer`-flow rows are ALREADY excluded from category/budget spend
 * (anti-double-count), so removing it changes no totals. It also MUST be
 * removed — `postReimbursementTransfer` finds an existing transfer for this
 * reimbursement via `by_reimbursement` UNCONDITIONALLY (no status filter), so
 * leaving the bounced row in place would make a future successful re-payout
 * mistake it for "already posted" and silently skip crediting the real
 * transfer. The full bounce history survives on the `payouts` row itself
 * (`status:"returned"` + `failureReason`) — this repo has no existing
 * transaction-level void/reversal convention to mirror, so the payout doc is
 * the audit trail here, same as the pre-paid `failed`/`returned` branch below
 * (which also doesn't touch `approvals`).
 */
async function reverseSettledPayout(
  ctx: MutationCtx,
  req: Doc<"reimbursementRequests"> | null,
  payout: Doc<"payouts">,
  failureReason?: string,
): Promise<void> {
  const now = Date.now();
  const transactionId = payout.transactionId;
  await ctx.db.patch(payout._id, {
    status: "returned",
    failureReason,
    transactionId: undefined,
    updatedAt: now,
  });
  // Only walk back a reimbursement THIS payout actually settled — defense
  // against a manager having already reconciled it some other way in between.
  if (req && req.status === "paid") {
    await ctx.db.patch(req._id, {
      status: "approved",
      paidAt: undefined,
      updatedAt: now,
    });
  }
  if (transactionId) {
    const txn = await ctx.db.get(transactionId);
    if (txn && req && txn.reimbursementId === req._id) {
      await ctx.db.delete(transactionId);
    }
  }
}

/**
 * Advance a payout toward `target`, guarding illegal transitions.
 *
 * `canceled` is fully terminal. `failed`/`returned` are terminal too EXCEPT
 * they idempotently no-op a REPEATED delivery of the same signal (a retried
 * webhook must not re-run the reversal below twice). A `paid` payout is
 * otherwise terminal — it ignores a later `processing`/`failed` — but a late
 * `returned` still reverses it (see `reverseSettledPayout`): a bounced ACH
 * credit can arrive days after Increase reports `submitted`.
 */
async function applyPayoutOutcome(
  ctx: MutationCtx,
  payout: Doc<"payouts">,
  target: PayoutTarget,
  failureReason?: string,
): Promise<void> {
  const now = Date.now();
  if (payout.status === "canceled") return;
  // Already resolved terminal — a repeated `failed`/`returned` webhook delivery
  // is an idempotent no-op (this ALSO catches a returned payout post-reversal).
  if (payout.status === "returned" || payout.status === "failed") return;

  const req = await ctx.db.get(payout.reimbursementId);

  if (payout.status === "paid") {
    if (target !== "returned") return; // otherwise paid is terminal
    await reverseSettledPayout(ctx, req, payout, failureReason);
    return;
  }

  switch (target) {
    case "processing":
      if (payout.status === "pending") {
        await ctx.db.patch(payout._id, { status: "processing", updatedAt: now });
      }
      return;
    case "paid":
      await ctx.db.patch(payout._id, { status: "paid", updatedAt: now });
      if (req) await settleReimbursementPaid(ctx, req, payout);
      return;
    case "failed":
    case "returned":
      await ctx.db.patch(payout._id, {
        status: target,
        failureReason,
        updatedAt: now,
      });
      // Walk the reimbursement back so a manager can retry / mark it paid.
      if (req && req.status === "paying") {
        await ctx.db.patch(req._id, { status: "approved", updatedAt: now });
      }
      return;
  }
}

// ── provisionChapterAccount (internalAction, ops-only) ───────────────────────

const beginProvisionReturns = v.union(
  v.object({
    kind: v.literal("existing"),
    account: increaseAccountSummaryValidator,
  }),
  v.object({
    kind: v.literal("provision"),
    accountId: v.id("increaseAccounts"),
    chapterId: financeScopeValidator,
    chapterName: v.string(),
  }),
);

/**
 * Find-or-create the `increaseAccounts` row for a SCOPE (a real chapter, or
 * `"central"` — WP-1.2). Returns the existing account when it's already active
 * (idempotent), else the row to provision + the name to open the Increase
 * Account under (a real chapter's name, or `CENTRAL_ACCOUNT_NAME`).
 *
 * Pure DB logic shared by BOTH authz paths: the caller-scoped `beginProvision`
 * (a manager provisioning their OWN chapter) and the ops-only
 * `beginProvisionForScope` (the WP-1.2 backfill / auto-provision-at-creation,
 * which may target ANY chapter or central — no caller-chapter membership to
 * gate on).
 */
async function doBeginProvision(
  ctx: MutationCtx,
  scope: FinanceScope,
): Promise<BeginProvisionResult> {
  // Mode-aware find-or-create: only ever look at / create the account for the
  // CURRENT environment. The other environment's row (if any) is untouched.
  const sandboxMode = await readSandbox(ctx);
  const existing = await getChapterAccountForMode(ctx, scope, sandboxMode);
  if (
    existing &&
    existing.onboardingStatus === "active" &&
    existing.increaseAccountId
  ) {
    return { kind: "existing", account: toAccountSummary(existing) };
  }

  const scopeName =
    scope === "central"
      ? CENTRAL_ACCOUNT_NAME
      : ((await ctx.db.get(scope))?.name ?? "Chapter");

  if (existing) {
    return {
      kind: "provision",
      accountId: existing._id,
      chapterId: scope,
      chapterName: scopeName,
    };
  }
  const now = Date.now();
  const accountId = await ctx.db.insert("increaseAccounts", {
    chapterId: scope,
    sandbox: sandboxMode,
    onboardingStatus: "not_started",
    createdAt: now,
    updatedAt: now,
  });
  return { kind: "provision", accountId, chapterId: scope, chapterName: scopeName };
}

/** Gate + find-or-create the CALLER'S OWN chapter's `increaseAccounts` row.
 *  Manager-only — the normal (non-ops) provisioning path. */
export const beginProvision = internalMutation({
  args: {},
  returns: beginProvisionReturns,
  handler: async (ctx): Promise<BeginProvisionResult> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return doBeginProvision(ctx, chapterId);
  },
});

/**
 * Ops-only counterpart of `beginProvision`: find-or-create the
 * `increaseAccounts` row for an EXPLICIT scope (any chapter, or `"central"`),
 * with NO caller-chapter gate — this is only ever invoked by
 * `backfillChapterAccounts` / `provisionAccountForScope` (internal actions,
 * never reachable from a client).
 */
export const beginProvisionForScope = internalMutation({
  args: { scope: financeScopeValidator },
  returns: beginProvisionReturns,
  handler: async (ctx, { scope }): Promise<BeginProvisionResult> =>
    doBeginProvision(ctx, scope),
});

/** Patch the `increaseAccounts` row after provisioning (or the degrade path). */
export const finishProvision = internalMutation({
  args: {
    accountId: v.id("increaseAccounts"),
    onboardingStatus: onboardingValidator,
    increaseEntityId: v.optional(v.string()),
    increaseAccountId: v.optional(v.string()),
  },
  returns: increaseAccountSummaryValidator,
  handler: async (ctx, args): Promise<IncreaseAccountSummary> => {
    const patch: Partial<Doc<"increaseAccounts">> = {
      onboardingStatus: args.onboardingStatus,
      updatedAt: Date.now(),
    };
    if (args.increaseEntityId) patch.increaseEntityId = args.increaseEntityId;
    if (args.increaseAccountId) patch.increaseAccountId = args.increaseAccountId;
    await ctx.db.patch(args.accountId, patch);
    const row = await ctx.db.get(args.accountId);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Increase account row vanished.",
      });
    }
    return toAccountSummary(row);
  },
});

/**
 * Provision a chapter's Increase Account under the org's single shared Entity.
 * Manager-only. Idempotent: an already-active account is returned untouched.
 *
 * SHARED-ENTITY MODEL: the org has ONE legal Increase Entity (the nonprofit),
 * KYB-verified ONCE in the Increase dashboard and referenced by
 * `INCREASE_ENTITY_ID`. This app NEVER creates entities and NEVER collects
 * KYB/PII — provisioning a chapter is just opening an Account under that shared
 * entity (`POST /accounts` with `entity_id` + `program_id` + a `name`).
 *
 * MATCH-BEFORE-CREATE: the org Entity may ALREADY hold an Account named for the
 * chapter (opened by hand in the Increase dashboard). Before creating, we list
 * the entity's accounts (`GET /accounts?entity_id=...`) and, if one matches the
 * chapter name (`pickMatchingAccount` — case-insensitive, fuzzy), LINK it instead
 * of opening a duplicate. Only a no-match path POSTs a new account.
 *
 * PROGRAM AUTO-RESOLUTION: a nonprofit has exactly ONE Increase Program, so
 * `INCREASE_PROGRAM_ID` is an OPTIONAL explicit override — when unset the Program
 * is resolved from `GET /programs` (`resolveProgramId`). A LINK needs no Program.
 *
 * MODE-AWARE: the runtime `financeSettings.sandboxMode` toggle chooses which
 * Increase environment a NEW account is opened in (`increaseEnvForMode`) — sandbox
 * (`INCREASE_SANDBOX_API_KEY`/`INCREASE_SANDBOX_ENTITY_ID`, sandbox base) or prod.
 * The account id comes back `sandbox_`-prefixed in sandbox, so it self-identifies
 * for every later operation via `increaseEnvForObjectId`.
 *
 * DEGRADES (logs the reason + returns, never throws) to
 * `onboardingStatus:"pending"` when the chosen mode's API key or Entity id is
 * unset (that environment isn't wired up yet), or when no Program resolves
 * (`/programs` returned 0 or >1 without an override, or the fetch failed).
 */
/**
 * Shared provisioning body once `prep` (existing-or-provision, resolved by
 * `beginProvision` or the ops-only `beginProvisionForScope`) is known. The SAME
 * Idempotency-Key + match-before-create discipline applies to every account —
 * chapter or central — so this is the ONE place that logic lives; reused by
 * both `provisionChapterAccount` (caller-scoped) and `provisionAccountForScope`
 * (ops-only, WP-1.2 backfill / auto-provision-at-creation).
 */
async function runProvisionFlow(
  ctx: ActionCtx,
  prep: BeginProvisionResult,
): Promise<IncreaseAccountSummary> {
  if (prep.kind === "existing") return prep.account;

  // Mode-aware: the runtime sandbox toggle (`financeSettings`) chooses which
  // Increase environment a NEW account is opened in. A sandbox-provisioned
  // account's id comes back `sandbox_`-prefixed, so all its later operations
  // self-select the sandbox regardless of the toggle's future state.
  const sandbox = await ctx.runQuery(
    internal.financeSettings.readSandboxMode,
    {},
  );
  const { key, base, entityId, programOverride } = increaseEnvForMode(sandbox);

  // Opening an Account needs the (mode's) API key + shared org Entity id. If
  // either is unset we can't provision → degrade to `pending` (log which one is
  // missing). The Program id is auto-resolved below (env override optional).
  const missing = !key
    ? sandbox
      ? "INCREASE_SANDBOX_API_KEY"
      : "INCREASE_API_KEY"
    : !entityId
      ? sandbox
        ? "INCREASE_SANDBOX_ENTITY_ID"
        : "INCREASE_ENTITY_ID"
      : null;
  if (missing) {
    console.warn(`[increase] provision skipped: ${missing} not configured`);
    return await ctx.runMutation(internal.increase.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "pending",
    });
  }

  // MATCH-BEFORE-CREATE: the org Entity may already hold an Account named for
  // this chapter (opened by hand in the Increase dashboard). List the entity's
  // accounts and, if one matches the chapter name, LINK it instead of opening a
  // duplicate. Mode-aware: this lists under the CURRENT-mode Entity with the
  // mode's key/base, so a matched account is persisted with the row's `sandbox`
  // value (set at row creation in `beginProvision`). A link needs no Program.
  let existingMatch: { id: string; name: string } | null = null;
  try {
    const list = (await increaseGet(
      key!,
      base,
      `/accounts?entity_id=${encodeURIComponent(entityId!)}`,
    )) as { data?: IncreaseAccountLite[] };
    const fetched = list.data ?? [];
    // CENTRAL must never fuzzy-adopt a pre-existing prod account whose name
    // merely overlaps `CENTRAL_ACCOUNT_NAME` (e.g. a bare "Public Worship")
    // — exact match only there. Chapters keep the fuzzy match.
    existingMatch = pickMatchingAccount(
      fetched,
      prep.chapterName,
      prep.chapterId === "central",
    );
    // Diagnostic: how many accounts the entity holds + whether we matched one.
    // The prod duplicate-cascade was a silent no-match — this makes it visible.
    console.log(
      `[increase] provision: match-before-create fetched ${fetched.length} account(s) under entity ${entityId}; ${
        existingMatch
          ? `matched "${existingMatch.name}" (${existingMatch.id})`
          : `no match for chapter "${prep.chapterName}"`
      }`,
    );
  } catch (err) {
    // Couldn't list the entity's accounts — we can't tell whether creating
    // would duplicate an existing one, so degrade rather than risk a duplicate.
    console.error(
      "[increase] provision: failed to list existing accounts:",
      err,
    );
    return await ctx.runMutation(internal.increase.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "pending",
    });
  }

  if (existingMatch) {
    console.log(
      `[increase] provision: LINKED existing account ${existingMatch.id} ("${existingMatch.name}") to chapter "${prep.chapterName}" — no new account created`,
    );
    return await ctx.runMutation(internal.increase.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "active",
      increaseEntityId: entityId!,
      increaseAccountId: existingMatch.id,
    });
  }
  console.log(
    `[increase] provision: no existing account matched chapter "${prep.chapterName}" — creating a new one`,
  );

  // Resolve the Program: explicit `INCREASE_PROGRAM_ID` override, else the sole
  // program from the mode's `GET /programs`. Null (0/>1 programs, or a fetch
  // error) → degrade to `pending` rather than open under a guessed program.
  const programId = await resolveProgramId(key!, base, programOverride);
  if (!programId) {
    console.warn("[increase] provision skipped: no Increase Program resolved");
    return await ctx.runMutation(internal.increase.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "pending",
    });
  }

  // Open the chapter's Account under the shared org Entity — no KYB, no PII.
  // IDEMPOTENT create: the `increaseAccounts` row id is stable per chapter+mode,
  // so we send it as the `Idempotency-Key`. A retry after a network blip that
  // ACTUALLY created the account then RETURNS the same account instead of
  // opening a duplicate — the root fix for the prod duplicate-cascade (each
  // Retry minting a fresh "The New York Chapter"). See `increasePost`.
  try {
    const account = await increasePost(
      key!,
      base,
      "/accounts",
      {
        entity_id: entityId!,
        program_id: programId,
        name: prep.chapterName,
      },
      String(prep.accountId),
    );
    // Capture the created account id ROBUSTLY: only mark `active` when the
    // response carried a usable id. A 2xx with no id (or a non-string id) is a
    // parse failure — log the raw body so it's diagnosable, and leave a clear
    // pending state rather than persisting a bogus `"undefined"` id.
    const newAccountId =
      typeof account.id === "string" && account.id ? account.id : null;
    if (!newAccountId) {
      console.error(
        `[increase] provision: /accounts create returned no usable account id for chapter "${prep.chapterName}"; raw response:`,
        JSON.stringify(account),
      );
      return await ctx.runMutation(internal.increase.finishProvision, {
        accountId: prep.accountId,
        onboardingStatus: "pending",
      });
    }
    console.log(
      `[increase] provision: CREATED account ${newAccountId} for chapter "${prep.chapterName}"`,
    );
    return await ctx.runMutation(internal.increase.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "active",
      increaseEntityId: entityId!,
      increaseAccountId: newAccountId,
    });
  } catch (err) {
    // `increasePost` already logged the raw non-2xx body before throwing.
    console.error("[increase] provision: create failed:", err);
    return await ctx.runMutation(internal.increase.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "pending",
    });
  }
}

/**
 * Provision the CALLER'S OWN chapter's Increase Account under the org's single
 * shared Entity. Manager-only. Idempotent: an already-active account is
 * returned untouched.
 *
 * SHARED-ENTITY MODEL: the org has ONE legal Increase Entity (the nonprofit),
 * KYB-verified ONCE in the Increase dashboard and referenced by
 * `INCREASE_ENTITY_ID`. This app NEVER creates entities and NEVER collects
 * KYB/PII — provisioning a chapter is just opening an Account under that shared
 * entity (`POST /accounts` with `entity_id` + `program_id` + a `name`).
 *
 * MATCH-BEFORE-CREATE / PROGRAM AUTO-RESOLUTION / MODE-AWARE / DEGRADES: see
 * `runProvisionFlow` above, which implements the shared body (identical for a
 * real chapter or `"central"` — the ops-only `provisionAccountForScope` below
 * reuses it verbatim).
 *
 * OPS-ONLY (WP-1.2): provisioning is now a fully automatic backend sweep
 * (`backfillChapterAccounts` / scheduled at chapter creation) — the UI screen
 * that used to call this as a manager escape hatch was deleted in this PR.
 * `internalAction` rather than a public `action`: the `run-convex-function`
 * workflow's deploy key can invoke internal functions directly (see that
 * workflow's own comment — "Internal functions are callable, the deploy key
 * is admin"), so there's no need for a public surface here anymore.
 */
export const provisionChapterAccount = internalAction({
  args: {},
  returns: increaseAccountSummaryValidator,
  handler: async (ctx): Promise<IncreaseAccountSummary> => {
    const prep: BeginProvisionResult = await ctx.runMutation(
      internal.increase.beginProvision,
      {},
    );
    return runProvisionFlow(ctx, prep);
  },
});

/**
 * Ops-only counterpart of `provisionChapterAccount` (WP-1.2): provision — or
 * confirm — the Increase account for an EXPLICIT scope (a chapter, or
 * `"central"`, the City Launch Fund's home). No caller-chapter gate; only
 * reachable from other internal functions, never a client.
 *
 * Used by `backfillChapterAccounts` (the ops sweep over every chapter +
 * central) and scheduled best-effort at new-chapter creation
 * (`seed.ensureChapters`) — see those call sites for the "auto" half of
 * "opaque + automatic".
 */
export const provisionAccountForScope = internalAction({
  args: { scope: financeScopeValidator },
  returns: increaseAccountSummaryValidator,
  handler: async (ctx, { scope }): Promise<IncreaseAccountSummary> => {
    const prep: BeginProvisionResult = await ctx.runMutation(
      internal.increase.beginProvisionForScope,
      { scope },
    );
    return runProvisionFlow(ctx, prep);
  },
});

// ── backfillChapterAccounts (internalAction, CLI/CI — WP-1.2) ────────────────

/** Every chapter id the backfill should consider (active chapters only — a
 *  deactivated demo chapter doesn't need a live money account). Central is
 *  handled separately (it isn't a `chapters` row). */
export const listChapterIdsForBackfill = internalQuery({
  args: {},
  returns: v.array(v.id("chapters")),
  handler: async (ctx) => {
    const chapters = await ctx.db.query("chapters").collect();
    return chapters.filter((c) => c.isActive !== false).map((c) => c._id);
  },
});

/**
 * Ops backfill (WP-1.2): provision an Increase account for every chapter — AND
 * the org level (`"central"`, the City Launch Fund's home) — that lacks an
 * ACTIVE account in the CURRENT mode. Reuses `provisionAccountForScope`
 * (Idempotency-Key + match-before-create discipline from #115/#123) per scope,
 * so it's the exact same logic a manager's own "Provision account" used to
 * run — just swept over every scope instead of the caller's one chapter.
 *
 * IDEMPOTENT: a scope with an already-active current-mode account is skipped
 * (`beginProvisionForScope` returns `kind:"existing"`) — safe to re-run.
 * Best-effort per scope: one scope's failure (network, missing env) degrades
 * that scope to `pending` (never throws) and the sweep continues.
 *
 * CLI/CI-runnable (internal → not publicly callable):
 *   npx convex run increase:backfillChapterAccounts
 *   gh workflow run run-convex-function.yml -f function=increase:backfillChapterAccounts
 */
export const backfillChapterAccounts = internalAction({
  args: {},
  returns: v.object({
    provisioned: v.array(
      v.object({ scope: v.string(), status: onboardingValidator }),
    ),
    skipped: v.array(v.string()),
  }),
  handler: async (
    ctx,
  ): Promise<{
    provisioned: { scope: string; status: IncreaseAccountSummary["onboardingStatus"] }[];
    skipped: string[];
  }> => {
    const chapterIds = await ctx.runQuery(
      internal.increase.listChapterIdsForBackfill,
      {},
    );
    const scopes: FinanceScope[] = ["central", ...chapterIds];

    const provisioned: {
      scope: string;
      status: IncreaseAccountSummary["onboardingStatus"];
    }[] = [];
    const skipped: string[] = [];
    for (const scope of scopes) {
      const label = scope === "central" ? "central" : String(scope);
      const prep = await ctx.runMutation(
        internal.increase.beginProvisionForScope,
        { scope },
      );
      if (prep.kind === "existing") {
        skipped.push(label);
        continue;
      }
      const account = await runProvisionFlow(ctx, prep);
      provisioned.push({ scope: label, status: account.onboardingStatus });
    }
    return { provisioned, skipped };
  },
});

// ── linkIncreaseAccount (internalAction, ops-only) — adopt an account by id ──

/** Gate a manual link + resolve the current environment. Manager-only, no
 *  writes — the action then GETs the account (mutations can't fetch) and
 *  `finishLink` upserts. Returns the mode so the action selects the right env. */
export const beginLink = internalMutation({
  args: {},
  returns: v.object({ sandbox: v.boolean() }),
  handler: async (ctx): Promise<{ sandbox: boolean }> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return { sandbox: await readSandbox(ctx) };
  },
});

/** Upsert the chapter's CURRENT-mode `increaseAccounts` row to a verified,
 *  linked account. Manager-only. REPLACES a stuck pending row (patches it in
 *  place — never a second row), else inserts. Marks it `active`. */
export const finishLink = internalMutation({
  args: {
    increaseAccountId: v.string(),
    increaseEntityId: v.string(),
    sandbox: v.boolean(),
  },
  returns: increaseAccountSummaryValidator,
  handler: async (
    ctx,
    { increaseAccountId, increaseEntityId, sandbox },
  ): Promise<IncreaseAccountSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const now = Date.now();
    // Mode-aware upsert: only ever touch the row for the CURRENT environment, so
    // a stuck pending PRODUCTION row is replaced (not duplicated) and any
    // off-mode row is left untouched.
    const existing = await getChapterAccountForMode(ctx, chapterId, sandbox);
    let accountId: Id<"increaseAccounts">;
    if (existing) {
      await ctx.db.patch(existing._id, {
        increaseAccountId,
        increaseEntityId,
        onboardingStatus: "active",
        sandbox,
        updatedAt: now,
      });
      accountId = existing._id;
    } else {
      accountId = await ctx.db.insert("increaseAccounts", {
        chapterId,
        sandbox,
        increaseEntityId,
        increaseAccountId,
        onboardingStatus: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    const row = await ctx.db.get(accountId);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Increase account row vanished.",
      });
    }
    return toAccountSummary(row);
  },
});

/**
 * Link an EXISTING Increase Account to this chapter by its id. Manager-only.
 * The reliable manual counterpart to auto-provision: when the owner already
 * opened (or already has) the chapter's Account in the Increase dashboard, they
 * paste its id here instead of relying on the fuzzy name-match — the fix for a
 * chapter left stuck `pending` after a failed provision.
 *
 * Operates in the CURRENT mode (`financeSettings.sandboxMode` → `increaseEnvForMode`):
 * it VERIFIES the account exists via `GET /accounts/{id}` under that mode's
 * key/base AND that it belongs to the mode's shared org Entity, then upserts the
 * chapter's current-mode row `{ increaseAccountId, increaseEntityId, active }`,
 * REPLACING a stuck pending row rather than creating a duplicate.
 *
 * DEGRADES to a logged no-op (returns null, never throws) when the mode's API
 * key or Entity id is unset. Throws `ConvexError` when the id doesn't exist in
 * this environment or belongs to a different entity.
 *
 * OPS-ONLY (WP-1.2): the manual-link UI was deleted in this PR along with
 * `provisionChapterAccount`'s — see that function's docstring for why
 * `internalAction` (rather than a public `action`) is safe here: the
 * `run-convex-function` workflow's admin deploy key calls internal functions
 * directly.
 */
export const linkIncreaseAccount = internalAction({
  args: { increaseAccountId: v.string() },
  returns: v.union(increaseAccountSummaryValidator, v.null()),
  handler: async (
    ctx,
    { increaseAccountId },
  ): Promise<IncreaseAccountSummary | null> => {
    const targetId = increaseAccountId.trim();
    if (!targetId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Enter an Increase account id to link.",
      });
    }

    // Manager gate FIRST (before any network probe of account existence).
    const { sandbox } = await ctx.runMutation(internal.increase.beginLink, {});
    const { key, base, entityId } = increaseEnvForMode(sandbox);

    // Verifying + linking needs the (mode's) API key + shared org Entity id. If
    // either is unset that environment isn't wired up → degrade to a no-op.
    if (!key || !entityId) {
      const missing = !key
        ? sandbox
          ? "INCREASE_SANDBOX_API_KEY"
          : "INCREASE_API_KEY"
        : sandbox
          ? "INCREASE_SANDBOX_ENTITY_ID"
          : "INCREASE_ENTITY_ID";
      console.warn(`[increase] link skipped: ${missing} not configured`);
      return null;
    }

    // VERIFY the account exists in this environment AND belongs to our entity.
    let account: Record<string, unknown>;
    try {
      const res = await fetch(
        `${base}/accounts/${encodeURIComponent(targetId)}`,
        { method: "GET", headers: { Authorization: `Bearer ${key}` } },
      );
      if (res.status === 404) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message:
            "No Increase account with that id exists in this environment. Double-check the id in your Increase dashboard.",
        });
      }
      if (!res.ok) {
        const bodyText = await res.text();
        console.error(
          `[increase] link: GET /accounts/${targetId} failed:`,
          bodyText,
        );
        // Surface the REAL cause (status + Increase's title/detail) so a prod
        // link failure — most often a 401/403 bad-key or a config problem — is
        // diagnosable instead of a generic "please try again". Never leaks the
        // API key (describeIncreaseError only echoes status + server error text).
        const env = sandbox ? "sandbox" : "production";
        throw new ConvexError({
          code: "INCREASE_ERROR",
          message: `Increase couldn't verify that account (${describeIncreaseError(res.status, bodyText)}). Check the ${env} Increase API key and that the account belongs to your org's entity.`,
        });
      }
      account = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ConvexError) throw err;
      // A network/parse failure (no HTTP response to read a status from) — echo
      // the underlying error message (never contains the key) rather than a
      // generic string, so a DNS/TLS/timeout is distinguishable from a bad key.
      console.error("[increase] link: failed to fetch account:", err);
      const reason = err instanceof Error ? err.message : String(err);
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: `Couldn't reach Increase to verify that account (${reason}). Check network access and the production Increase configuration.`,
      });
    }

    // The account MUST belong to the org's shared Entity for this mode — never
    // link an account from a different entity to this chapter.
    const accountEntityId =
      typeof account.entity_id === "string" ? account.entity_id : null;
    if (accountEntityId !== entityId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message:
          "That Increase account belongs to a different entity, so it can't be linked to this chapter.",
      });
    }

    // Persist the canonical id from Increase (correct casing / `sandbox_`
    // prefix), replacing a stuck pending row rather than minting a duplicate.
    const canonicalId =
      typeof account.id === "string" && account.id ? account.id : targetId;
    return await ctx.runMutation(internal.increase.finishLink, {
      increaseAccountId: canonicalId,
      increaseEntityId: entityId,
      sandbox,
    });
  },
});

// ── payReimbursement (action, manager) ───────────────────────────────────────

/** Gate + load the reimbursement + find-or-create its payout (idempotency-keyed
 *  on `reimbursementId`). Manager-only. Returns an existing LIVE payout as-is
 *  (never double-pays), else decides ACH-vs-manual and creates the payout row. */
export const beginPayout = internalMutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  returns: v.union(
    v.object({ kind: v.literal("existing"), payout: payoutSummaryValidator }),
    v.object({ kind: v.literal("manual"), payout: payoutSummaryValidator }),
    v.object({
      kind: v.literal("increase"),
      payoutId: v.id("payouts"),
      increaseAccountId: v.string(),
      amountCents: v.number(),
      reimbursementId: v.id("reimbursementRequests"),
      externalAccountId: v.union(v.string(), v.null()),
      accountNumber: v.union(v.string(), v.null()),
      routingNumber: v.union(v.string(), v.null()),
      funding: v.union(v.literal("checking"), v.literal("savings"), v.null()),
    }),
  ),
  handler: async (ctx, { reimbursementId }): Promise<BeginPayoutResult> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const req = await ctx.db.get(reimbursementId);
    await requireInChapter(ctx, chapterId, req, "Reimbursement");
    const reimbursement = req!;
    if (reimbursement.status !== "approved") {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "Only an approved reimbursement can be paid.",
      });
    }

    // Disbursement SoD: the caller releasing the payout must not be the payee.
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    const callerEmail = await getUserEmail(ctx);
    assertDisbursementSoD(callerPersonId, callerEmail, reimbursement);

    // Reject a non-positive amount before any payout row is minted.
    const amountCents = reimbursement.approvedCents ?? reimbursement.totalCents;
    assertPositivePayout(amountCents);

    // IDEMPOTENT: at most one live payout per reimbursement — never double-pay.
    const existingPayouts = await ctx.db
      .query("payouts")
      .withIndex("by_reimbursement", (q) =>
        q.eq("reimbursementId", reimbursementId),
      )
      .take(50);
    const live = existingPayouts.find((p) =>
      LIVE_PAYOUT_STATUSES.includes(p.status),
    );
    if (live) return { kind: "existing", payout: toPayoutSummary(live) };

    const now = Date.now();

    // Is a real ACH addressable? Needs the vendor wired, an active account, AND
    // a full destination — a linked Increase External Account, captured at
    // submission time via `linkPublicBankAccount` / `linkBankAccount`
    // (`reimbursements.ts`). Absent that link (the member never provided full
    // bank details, or the Increase call degraded), we fall back to manual.
    const hasFullDestination = !!reimbursement.externalAccountId;
    // Mode-aware: pay from the chapter's CURRENT-environment account (never
    // `.first()`, which would arbitrarily pick sandbox-or-prod once both exist).
    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    // The key that will ACTUALLY be used to originate the transfer is resolved
    // from the ACCOUNT's own id prefix (`increaseEnvForObjectId`), NOT the
    // deployment's plain `INCREASE_API_KEY` — a sandbox-provisioned account
    // must be paid with `INCREASE_SANDBOX_API_KEY` even in production mode.
    // Checking the wrong env var here would silently degrade every sandbox
    // payout to manual even once fully wired.
    const accountEnvKey = account?.increaseAccountId
      ? increaseEnvForObjectId(account.increaseAccountId).key
      : undefined;
    const canAch =
      !!accountEnvKey &&
      !!account &&
      account.onboardingStatus === "active" &&
      !!account.increaseAccountId &&
      hasFullDestination;

    if (canAch) {
      const payoutId = await ctx.db.insert("payouts", {
        chapterId,
        reimbursementId,
        payeePersonId: reimbursement.personId,
        amountCents,
        provider: "increase",
        status: "pending",
        bankAccountLast4: reimbursement.bankAccountLast4,
        createdAt: now,
        updatedAt: now,
      });
      return {
        kind: "increase",
        payoutId,
        increaseAccountId: account!.increaseAccountId!,
        amountCents,
        reimbursementId,
        externalAccountId: reimbursement.externalAccountId ?? null,
        accountNumber: null,
        routingNumber: null,
        funding: null,
      };
    }

    // Degrade: a manual payout the manager completes via `markPaidManually`.
    const payoutId = await ctx.db.insert("payouts", {
      chapterId,
      reimbursementId,
      payeePersonId: reimbursement.personId,
      amountCents,
      provider: "manual",
      status: "pending",
      bankAccountLast4: reimbursement.bankAccountLast4,
      createdAt: now,
      updatedAt: now,
    });
    const payout = await ctx.db.get(payoutId);
    return { kind: "manual", payout: toPayoutSummary(payout!) };
  },
});

/** Terminal ACH-transfer statuses. A transfer in one of these can never move
 *  money — if Increase returns one on our CREATE call, it's a REPLAY of a dead
 *  prior transfer, not a fresh origination (see `applyAchTransfer`). */
const TERMINAL_TRANSFER_STATUSES = [
  "returned",
  "canceled",
  "cancelled",
  "rejected",
  "failed",
];

/**
 * Apply a created Increase ACH transfer to the payout: `processing` +
 * `increaseTransferId`, and move the reimbursement to `paying`.
 *
 * REPLAY-OF-TERMINAL GUARD: Increase idempotency keys (we key on
 * `reimbursementId`) NEVER expire — one object per key, forever. After a
 * paid→returned reversal (`reverseSettledPayout`), RE-paying the same
 * reimbursement replays the ORIGINAL, now-BOUNCED transfer instead of
 * originating a new one. Stamping that dead transfer onto the fresh payout would
 * wedge it forever: no webhook ever arrives, `markPaidManually` throws
 * PAYOUT_IN_FLIGHT, and reject/cancel are illegal from `paying`. We detect the
 * DEAD replay two robust ways: (1) the replayed transfer's own status is TERMINAL
 * (`returned`/`canceled`/`rejected`/`failed`), and (2) ANOTHER payout already
 * carries this `increaseTransferId` — which only happens when a prior, now-dead
 * payout minted it (a still-LIVE prior payout would have blocked the re-pay at
 * `beginPayout`, so a match here is always a dead prior). On either, FAIL this
 * payout with `idempotent_replay` WITHOUT advancing the reimbursement (it stays
 * `approved`, so `markPaidManually` still works); the action throws a clear error.
 *
 * We deliberately do NOT trigger on the `Idempotent-Replayed` header alone: a
 * legitimate network-timeout retry also replays — but of a STILL-LIVE transfer,
 * which must be ADOPTED (marked `processing`), not failed. The two signals above
 * fire only for a DEAD replay, so timeout-retry adoption is preserved.
 */
export const applyAchTransfer = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    increaseTransferId: v.string(),
    transferStatus: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ kind: v.literal("applied"), payout: payoutSummaryValidator }),
    v.object({ kind: v.literal("replay") }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{ kind: "applied"; payout: PayoutSummary } | { kind: "replay" }> => {
    const now = Date.now();

    // Dead-replay detection (see the doc comment above).
    const statusTerminal =
      !!args.transferStatus &&
      TERMINAL_TRANSFER_STATUSES.includes(args.transferStatus.toLowerCase());
    const othersWithSameTransfer = await ctx.db
      .query("payouts")
      .withIndex("by_increase_transfer", (q) =>
        q.eq("increaseTransferId", args.increaseTransferId),
      )
      .collect();
    const replayedOntoOtherPayout = othersWithSameTransfer.some(
      (p) => p._id !== args.payoutId,
    );
    if (statusTerminal || replayedOntoOtherPayout) {
      await ctx.db.patch(args.payoutId, {
        status: "failed",
        failureReason: "idempotent_replay",
        updatedAt: now,
      });
      return { kind: "replay" };
    }

    await ctx.db.patch(args.payoutId, {
      provider: "increase",
      status: "processing",
      increaseTransferId: args.increaseTransferId,
      updatedAt: now,
    });
    const payout = await ctx.db.get(args.payoutId);
    if (!payout) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Payout not found." });
    }
    const req = await ctx.db.get(payout.reimbursementId);
    if (req && req.status === "approved") {
      await ctx.db.patch(req._id, {
        status: "paying",
        payoutId: payout._id,
        updatedAt: now,
      });
    }
    return { kind: "applied", payout: toPayoutSummary(payout) };
  },
});

/** Mark a payout `failed` after the ACH create call itself failed. */
export const failPayout = internalMutation({
  args: { payoutId: v.id("payouts"), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.payoutId, {
      status: "failed",
      failureReason: args.reason,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Pay an approved reimbursement over ACH from the chapter's Increase account.
 * Manager-only. IDEMPOTENT: a live payout already keyed on `reimbursementId` is
 * returned as-is (never double-pays).
 *
 * DESTINATION-DETAILS GAP: the form only captured `bankAccountLast4`, so a real
 * ACH can't be fully addressed yet — this DEGRADES to a `manual`/`pending`
 * payout and the manager finishes via `markPaidManually`. When the ACH path is
 * enabled, it creates an Increase transfer with `Idempotency-Key:
 * <reimbursementId>`, sets the payout `processing` + the reimbursement `paying`.
 */
export const payReimbursement = action({
  args: { reimbursementId: v.id("reimbursementRequests") },
  returns: payoutSummaryValidator,
  handler: async (ctx, { reimbursementId }): Promise<PayoutSummary> => {
    const result: BeginPayoutResult = await ctx.runMutation(
      internal.increase.beginPayout,
      { reimbursementId },
    );
    if (result.kind === "existing" || result.kind === "manual") {
      return result.payout;
    }

    // ACH path (enabled once full destination details are captured). Self-select
    // the Increase env from the chapter account's id prefix: a sandbox-
    // provisioned account (`sandbox_...`) routes to the sandbox with its key, a
    // prod account to prod — regardless of the current sandbox toggle. Env not
    // wired for that account's environment → degrade (fail the payout, throw).
    const { key, base } = increaseEnvForObjectId(result.increaseAccountId);
    if (!key) {
      await ctx.runMutation(internal.increase.failPayout, {
        payoutId: result.payoutId,
        reason: "increase_key_unset",
      });
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: "Couldn't start the ACH payout. Please try again.",
      });
    }

    // Address the ACH credit. Increase requires EITHER `external_account_id` OR
    // `account_number` + `routing_number` (+ `funding`) — never both. Gated by
    // `hasFullDestination` in `beginPayout`, so `destination` is never null here
    // in practice; the guard keeps us from ever sending an unaddressed credit.
    const destination: Record<string, unknown> | null = result.externalAccountId
      ? { external_account_id: result.externalAccountId }
      : result.accountNumber && result.routingNumber
        ? {
            account_number: result.accountNumber,
            routing_number: result.routingNumber,
            funding: result.funding ?? "checking",
          }
        : null;
    if (!destination) {
      await ctx.runMutation(internal.increase.failPayout, {
        payoutId: result.payoutId,
        reason: "missing_destination",
      });
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: "Missing ACH destination details for this payout.",
      });
    }

    try {
      const transfer = await increasePost(
        key,
        base,
        "/ach_transfers",
        {
          account_id: result.increaseAccountId,
          // POSITIVE cents originates a CREDIT that pushes funds to the payee.
          amount: result.amountCents,
          // Increase requires a statement descriptor, max 10 characters.
          statement_descriptor: "Reimburse",
          ...destination,
        },
        // Idempotency-Key = reimbursementId (the schema's idempotency key).
        // KEEP this key (never switch to payoutId): a network-timeout retry must
        // replay THE SAME transfer, not originate a second one (double-pay). The
        // trade-off — a replay of a BOUNCED transfer after a reversal — is caught
        // by `applyAchTransfer`'s dead-replay guard (via the replayed transfer's
        // terminal status + the prior payout still holding the id).
        String(reimbursementId),
      );
      const applied = await ctx.runMutation(internal.increase.applyAchTransfer, {
        payoutId: result.payoutId,
        increaseTransferId: String(transfer.id),
        transferStatus:
          typeof transfer.status === "string" ? transfer.status : undefined,
      });
      if (applied.kind === "replay") {
        // Increase replayed a dead (already-returned/failed) transfer for this
        // reimbursement's idempotency key — it can no longer be paid over ACH.
        // The payout is marked `failed:idempotent_replay`; the reimbursement is
        // left `approved` so a manager can still `markPaidManually`.
        throw new ConvexError({
          code: "IDEMPOTENT_REPLAY",
          message:
            "This request can no longer be paid by ACH — pay manually and mark paid.",
        });
      }
      return applied.payout;
    } catch (err) {
      // A deliberate replay-of-terminal rejection must propagate as-is (it's not
      // a transient ACH failure — do NOT re-fail the payout or mask the message).
      if (err instanceof ConvexError && err.data?.code === "IDEMPOTENT_REPLAY") {
        throw err;
      }
      console.error("[increase] ach transfer failed:", err);
      await ctx.runMutation(internal.increase.failPayout, {
        payoutId: result.payoutId,
        reason: "ach_create_failed",
      });
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: "Couldn't start the ACH payout. Please try again.",
      });
    }
  },
});

// ── markPaidManually (mutation, manager) — the working Phase-4 path ──────────

/**
 * Mark an approved reimbursement paid by hand (the working Phase-4 path while
 * ACH destination linking isn't built). Manager-only. Find-or-creates the
 * `manual` payout, marks it `paid`, sets the reimbursement `paid` + `paidAt`,
 * posts the offsetting `flow:"transfer"` ledger row (excluded from spend), and
 * appends a `"pay"` entry to the audit trail. IDEMPOTENT: a re-call after it's
 * paid returns the payout without a second transaction or audit row.
 */
export const markPaidManually = mutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  returns: payoutSummaryValidator,
  handler: async (ctx, { reimbursementId }): Promise<PayoutSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);

    const req = await ctx.db.get(reimbursementId);
    await requireInChapter(ctx, chapterId, req, "Reimbursement");
    const reimbursement = req!;

    // Disbursement SoD: the caller releasing the payout must not be the payee.
    const callerEmail = await getUserEmail(ctx);
    assertDisbursementSoD(callerPersonId, callerEmail, reimbursement);

    // Find (or create) the live payout keyed on the reimbursement.
    const existingPayouts = await ctx.db
      .query("payouts")
      .withIndex("by_reimbursement", (q) =>
        q.eq("reimbursementId", reimbursementId),
      )
      .take(50);
    let payout =
      existingPayouts.find((p) => LIVE_PAYOUT_STATUSES.includes(p.status)) ??
      null;

    // NEVER manual-clobber an in-flight real ACH payout. Once ACH is enabled a
    // `provider:"increase"` payout with an `increaseTransferId` is (or may be)
    // moving money at Increase; marking it paid by hand here would double-pay
    // (the ACH still settles). Only the true manual/degraded case is completable.
    if (payout && payout.provider === "increase" && payout.increaseTransferId) {
      throw new ConvexError({
        code: "PAYOUT_IN_FLIGHT",
        message:
          "This reimbursement has an ACH payout in progress — it can't be marked paid manually.",
      });
    }

    // IDEMPOTENT: already paid (payout paid + transfer posted) → return as-is.
    if (payout && payout.status === "paid" && reimbursement.status === "paid") {
      return toPayoutSummary(payout);
    }

    // Only an approved / already-paying reimbursement can be marked paid.
    if (
      reimbursement.status !== "approved" &&
      reimbursement.status !== "paying"
    ) {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "Only an approved reimbursement can be marked paid.",
      });
    }

    // Reject a non-positive amount (guards the `0 ?? x === 0` $0-payout trap).
    const amountCents =
      reimbursement.approvedCents ?? reimbursement.totalCents;
    assertPositivePayout(amountCents);
    const now = Date.now();

    if (!payout) {
      const payoutId = await ctx.db.insert("payouts", {
        chapterId,
        reimbursementId,
        payeePersonId: reimbursement.personId,
        amountCents,
        provider: "manual",
        status: "pending",
        bankAccountLast4: reimbursement.bankAccountLast4,
        createdAt: now,
        updatedAt: now,
      });
      payout = (await ctx.db.get(payoutId))!;
    }

    await ctx.db.patch(payout._id, {
      provider: "manual",
      status: "paid",
      updatedAt: now,
    });
    await ctx.db.patch(reimbursement._id, {
      status: "paid",
      paidAt: reimbursement.paidAt ?? now,
      payoutId: payout._id,
      updatedAt: now,
    });
    // Offsetting `transfer` ledger row (idempotent — one per reimbursement).
    await postReimbursementTransfer(ctx, chapterId, reimbursement, payout);

    // Append to the append-only approval/audit trail.
    await ctx.db.insert("approvals", {
      chapterId,
      subjectType: "payout",
      subjectId: String(payout._id),
      action: "pay",
      actorPersonId: callerPersonId,
      createdAt: now,
    });

    const fresh = await ctx.db.get(payout._id);
    return toPayoutSummary(fresh!);
  },
});

// ── Increase CARD-charge ingestion → the `transactions` ledger ───────────────

/**
 * Ground truth (verified against the real Increase API — increase.com/documentation
 * + the increase-node SDK types):
 *  - A settled card charge/refund arrives as a `transaction.created` Event whose
 *    `associated_object_id` is a `transaction_…` id; the Event carries NO inline
 *    object, so we FETCH `GET /transactions/{id}`.
 *  - `Transaction.amount` is a SIGNED integer in the currency's minor unit (cents):
 *    NEGATIVE for a charge (money leaving) → `outflow`, POSITIVE for a refund/credit
 *    → `inflow`. Direction lives in `transactions.flow`; `amountCents` is the abs.
 *  - The card is identified via `source.card_settlement` / `source.card_refund`.
 *    IMPORTANT: those objects do NOT carry `card_id` — they carry `card_payment_id`.
 *    The `card_id` lives on the Card Payment (`GET /card_payments/{id}` → `card_id`),
 *    which we then match to our `cards.increaseCardId` (`by_increase_card`).
 *  - PENDING authorizations (`pending_transaction.created`, `card_authorization`)
 *    are NOT ingested: the real-time decision path (`decideCardAuthorization`)
 *    already governs holds, and the settled `transactions` row is the ledger truth.
 */

/** The card-charge source categories we ingest. Everything else on a
 *  `transaction.created` (ACH, fees, interest, …) is NOT a card charge → skipped. */
const CARD_SOURCE_CATEGORIES = ["card_settlement", "card_refund"] as const;

/** The subset of a fetched Increase `Transaction` object we read. */
interface IncreaseTransactionLite {
  id?: string;
  account_id?: string;
  amount?: number; // signed minor units (negative = a charge)
  created_at?: string;
  currency?: string;
  description?: string;
  source?: {
    category?: string;
    card_settlement?: IncreaseCardSourceLite | null;
    card_refund?: IncreaseCardSourceLite | null;
  };
}

/** The card_settlement / card_refund sub-object (merchant + the card-payment link). */
interface IncreaseCardSourceLite {
  card_payment_id?: string;
  merchant_name?: string;
  merchant_category_code?: string;
}

/** The extracted, provider-agnostic card charge we hand to the DB apply. */
interface ExtractedCardCharge {
  externalId: string;
  accountId: string;
  flow: "outflow" | "inflow";
  amountCents: number;
  postedAt: number;
  merchantName?: string;
  merchantCategory?: string;
  cardPaymentId?: string;
}

/**
 * Pull the card-charge fields out of a fetched Increase `Transaction`, or null if
 * it isn't a settled card charge/refund we should ingest (wrong source category,
 * missing id/account, or a $0 settlement). Flow + amount come from the SIGNED
 * top-level `amount` (negative = outflow); the merchant + card-payment link come
 * from the matching `card_settlement` / `card_refund` sub-object.
 */
export function extractCardCharge(
  txn: IncreaseTransactionLite,
): ExtractedCardCharge | null {
  const category = txn.source?.category;
  if (
    !category ||
    !(CARD_SOURCE_CATEGORIES as readonly string[]).includes(category)
  ) {
    return null;
  }
  const externalId = txn.id;
  const accountId = txn.account_id;
  if (!externalId || !accountId) return null;
  if (typeof txn.amount !== "number" || !Number.isFinite(txn.amount)) return null;

  const amountCents = Math.abs(Math.round(txn.amount));
  if (amountCents === 0) {
    // A $0 settlement carries no ledger meaning — skipped, but logged so it's
    // traceable during reconciliation (rather than silently vanishing).
    console.debug(
      `[increase] card ingestion: skipping $0 settlement for transaction ${txn.id ?? "<unknown>"}`,
    );
    return null;
  }
  const flow: "outflow" | "inflow" = txn.amount < 0 ? "outflow" : "inflow";

  const card =
    category === "card_settlement"
      ? txn.source?.card_settlement
      : txn.source?.card_refund;
  const postedAt = txn.created_at ? Date.parse(txn.created_at) : NaN;

  return {
    externalId,
    accountId,
    flow,
    amountCents,
    postedAt: Number.isFinite(postedAt) ? postedAt : Date.now(),
    merchantName: card?.merchant_name ?? undefined,
    merchantCategory: card?.merchant_category_code ?? undefined,
    cardPaymentId: card?.card_payment_id ?? undefined,
  };
}

/**
 * Insert a settled Increase card charge into the `transactions` ledger — the pure
 * DB apply (no network), so the ingestion is testable without hitting Increase.
 *
 * IDEMPOTENT: dedups on `externalId` (the Increase transaction id) via
 * `by_external_id` — a redelivered webhook or an overlapping backfill never
 * double-inserts. Resolves the owning chapter from `accountId` → `increaseAccounts`
 * (`by_increase_account`); a transaction for an account we don't hold is SKIPPED.
 * Attribution: `increaseCardId` → our `cards` (`by_increase_card`, verified in the
 * resolved chapter) fills `cardId` / `personId` / `cardLast4`; an unmatched card
 * still records the txn with null attribution (a human reconciles it). New rows
 * land `status:"unreviewed"`, `pending:false` (settled).
 */
export const applyIncreaseCardTransaction = internalMutation({
  args: {
    externalId: v.string(),
    accountId: v.string(),
    flow: v.union(v.literal("outflow"), v.literal("inflow")),
    amountCents: v.number(),
    currency: v.optional(v.string()),
    postedAt: v.number(),
    merchantName: v.optional(v.string()),
    merchantCategory: v.optional(v.string()),
    // The resolved Increase card id (from the Card Payment), or absent when
    // attribution couldn't be resolved — the txn is still recorded.
    increaseCardId: v.optional(v.string()),
  },
  returns: v.object({ inserted: v.boolean(), skipped: v.boolean() }),
  handler: async (ctx, args): Promise<{ inserted: boolean; skipped: boolean }> => {
    // Dedup: one ledger row per Increase transaction id.
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.externalId))
      .first();
    if (existing) return { inserted: false, skipped: false };

    // Resolve the owning chapter from the Increase account id. Not ours → skip.
    const account = await ctx.db
      .query("increaseAccounts")
      .withIndex("by_increase_account", (q) =>
        q.eq("increaseAccountId", args.accountId),
      )
      .first();
    if (!account) return { inserted: false, skipped: true };
    // Central (WP-1.2) holds its OWN Increase account (the City Launch Fund).
    // WP-2.1 lets money belong to central, so a charge landing on the central
    // account is INGESTED as a central-owned txn (`chapterId:"central"`) rather
    // than dropped. Central issues no member cards, so card attribution never
    // resolves and the fund default is null (central has no funds) — the row
    // records with null card/person/fund, for the central desk to reconcile.
    const chapterId: FinanceScope = account.chapterId;

    // Attribute to a native card in THIS scope (never cross-chapter). Central
    // has no cards, so this is always null there. An unmatched card id leaves
    // attribution null — the row is still recorded.
    let card: Doc<"cards"> | null = null;
    if (args.increaseCardId) {
      const cards = await ctx.db
        .query("cards")
        .withIndex("by_increase_card", (q) =>
          q.eq("increaseCardId", args.increaseCardId),
        )
        .collect();
      card = cards.find((c) => c.chapterId === chapterId) ?? null;
    }

    // Silently pre-code to the chapter's General Fund — funds are
    // backend-only (see WP-1.4), so a native Increase card charge never
    // lands fund-less waiting on a UI that no longer exists. Central has no
    // funds (`defaultFundId` returns null for it), so a central-owned charge
    // stays fund-less.
    const fundId = (await defaultFundId(ctx, chapterId)) ?? undefined;

    const txnId = await ctx.db.insert("transactions", {
      chapterId,
      source: "increase_card",
      flow: args.flow,
      amountCents: args.amountCents,
      currency: args.currency ?? "usd",
      postedAt: args.postedAt,
      merchantName: args.merchantName,
      merchantCategory: args.merchantCategory,
      cardLast4: card?.last4,
      cardId: card?._id,
      personId: card?.cardholderPersonId,
      fundId,
      externalId: args.externalId,
      sourceAccountId: args.accountId,
      pending: false,
      status: "unreviewed",
      createdAt: Date.now(),
    });
    // ON-INGEST HOOK (owner: suggestions generated AS TRANSACTIONS ARRIVE,
    // not just on the hourly sweep) — fire-and-forget: ONLY schedules a
    // separate transaction that does the actual eligibility + debounce work
    // (central-owned / already-coded txns no-op there), so neither a throw
    // nor debounce-mutex contention can ever roll back this money insert.
    // See `aiCodingData.queueSuggestionOnIngest`'s doc comment.
    await queueSuggestionOnIngest(ctx, txnId);
    return { inserted: true, skipped: false };
  },
});

/**
 * Resolve a settled card charge's `card_id` by fetching its Card Payment
 * (`GET /card_payments/{id}`), since neither `card_settlement` nor `card_refund`
 * carries `card_id` inline. Best-effort: returns null (never throws) on a missing
 * id, a 404, or any fetch/parse error — attribution then falls back to null and
 * the charge is still recorded. `cache` memoizes within a backfill run so many
 * charges on one card cost one fetch.
 */
async function resolveIncreaseCardId(
  key: string,
  base: string,
  cardPaymentId: string | undefined,
  cache?: Map<string, string | null>,
): Promise<string | null> {
  if (!cardPaymentId) return null;
  if (cache?.has(cardPaymentId)) return cache.get(cardPaymentId) ?? null;
  let cardId: string | null = null;
  try {
    const payment = await increaseGet(
      key,
      base,
      `/card_payments/${encodeURIComponent(cardPaymentId)}`,
    );
    cardId = typeof payment.card_id === "string" ? payment.card_id : null;
  } catch (err) {
    console.error(
      `[increase] card ingestion: failed to fetch card_payment ${cardPaymentId}`,
      err,
    );
    cardId = null;
  }
  cache?.set(cardPaymentId, cardId);
  return cardId;
}

/** Cheap `by_external_id` existence check, used to short-circuit a redelivered
 *  webhook BEFORE the network fetch below (avoids a wasted `GET /transactions`
 *  + `GET /card_payments` round trip for a transaction we've already ingested). */
export const transactionExistsByExternalId = internalQuery({
  args: { externalId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { externalId }) => {
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .first();
    return existing !== null;
  },
});

/**
 * Fetch a settled card `transaction.created` object and post it to the ledger.
 * Best-effort (never throws): fetches `GET /transactions/{id}`, extracts the card
 * charge, resolves `card_id` via the Card Payment, and applies it (idempotent on
 * `externalId`). Routed by the object id's `sandbox_` prefix like the rest of the
 * file. Degrades to a logged no-op when the environment's key is unset or a fetch
 * fails.
 *
 * IMPORTANT — never throws. This is called from `handleIncreaseWebhook`, which
 * runs AFTER `recordWebhookEvent` has already committed the event-dedup row in a
 * separate, already-committed step (see `apps/convex/webhooks.ts`). If this
 * function threw, Increase's retry would be dead-on-arrival — the event id
 * already reads as "processed" — and that charge would be silently dropped with
 * no trace. Every fallible step (the transaction fetch, extraction, and the DB
 * apply) is therefore individually guarded; on any error we log (with the
 * transaction id) and return, matching the PR's best-effort design. The daily
 * `backfillIncreaseCardTransactions` cron (see `crons.ts`) is the reconciliation
 * backstop for anything a swallowed error here would otherwise lose forever.
 */
async function ingestIncreaseCardTransaction(
  ctx: ActionCtx,
  transactionId: string,
): Promise<void> {
  const { key, base } = increaseEnvForObjectId(transactionId);
  if (!key) {
    console.warn(
      "[increase] card ingestion skipped: Increase API key not configured for this environment",
    );
    return;
  }

  // Dedup BEFORE the network fetch — a redelivered webhook for an
  // already-ingested transaction short-circuits without a wasted round trip.
  const alreadyIngested = await ctx.runQuery(
    internal.increase.transactionExistsByExternalId,
    { externalId: transactionId },
  );
  if (alreadyIngested) return;

  let txn: IncreaseTransactionLite;
  try {
    txn = (await increaseGet(
      key,
      base,
      `/transactions/${encodeURIComponent(transactionId)}`,
    )) as IncreaseTransactionLite;
  } catch (err) {
    console.error("[increase] card ingestion: failed to fetch transaction", err);
    return;
  }

  try {
    const charge = extractCardCharge(txn);
    if (!charge) return; // not a settled card charge/refund → nothing to ingest

    const increaseCardId = await resolveIncreaseCardId(
      key,
      base,
      charge.cardPaymentId,
    );

    await ctx.runMutation(internal.increase.applyIncreaseCardTransaction, {
      externalId: charge.externalId,
      accountId: charge.accountId,
      flow: charge.flow,
      amountCents: charge.amountCents,
      currency: (txn.currency ?? "usd").toLowerCase(),
      postedAt: charge.postedAt,
      merchantName: charge.merchantName,
      merchantCategory: charge.merchantCategory,
      increaseCardId: increaseCardId ?? undefined,
    });
  } catch (err) {
    // Never throw out of the webhook: recordWebhookEvent already committed the
    // event-dedup row in a separate step, so a throw here would make this
    // charge unrecoverable (Increase's retry reads the event as "processed").
    // The daily backfill cron reconciles anything lost here.
    console.error(
      `[increase] card ingestion: failed to apply transaction ${transactionId}`,
      err,
    );
  }
}

// ── Backfill: page GET /transactions?account_id=… into the ledger ────────────

/** Active Increase accounts (id + owning chapter) for the backfill to page.
 *  Excludes `"central"` (the City Launch Fund's own account): central never
 *  issues member cards (see `applyIncreaseCardTransaction`'s defensive skip),
 *  so paging its transactions would just be a pointless prod API sweep. */
export const listProvisionedIncreaseAccounts = internalQuery({
  args: {},
  returns: v.array(v.object({ increaseAccountId: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("increaseAccounts").collect();
    return rows
      .filter(
        (a) =>
          a.chapterId !== "central" &&
          a.onboardingStatus === "active" &&
          !!a.increaseAccountId,
      )
      .map((a) => ({ increaseAccountId: a.increaseAccountId! }));
  },
});

/** A per-account page cap (each page is up to INCREASE_PAGE_SIZE rows). Bounds a
 *  single ops run; a genuinely huge account can be re-run to continue (dedup). */
const INCREASE_BACKFILL_MAX_PAGES = 200;
const INCREASE_PAGE_SIZE = 100;

/**
 * Ops backfill: page `GET /transactions?account_id=…` to completion for each
 * provisioned Increase account and post every settled card charge/refund into the
 * `transactions` ledger (dedup on `externalId`). Mirrors the Stripe FC backfill
 * (`stripeFinance.syncTransactions`) — Increase lists are cursor-paginated
 * (`{ data, next_cursor }`, `cursor` query param). Attribution reuses the Card
 * Payment lookup with a per-run cache. Environment is routed per account by its
 * `sandbox_` id prefix. Logs the inserted count. Best-effort: an account whose
 * environment key is unset, or a fetch error, logs + moves on (never throws).
 *
 * CLI/CI-runnable (internal → not publicly callable):
 *   npx convex run increase:backfillIncreaseCardTransactions
 *   gh workflow run run-convex-function.yml -f function=increase:backfillIncreaseCardTransactions
 * Optionally scope to one account: `-f args='{"increaseAccountId":"account_…"}'`.
 */
export const backfillIncreaseCardTransactions = internalAction({
  args: { increaseAccountId: v.optional(v.string()) },
  returns: v.object({
    accounts: v.number(),
    scanned: v.number(),
    inserted: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ accounts: number; scanned: number; inserted: number }> => {
    const accountIds = args.increaseAccountId
      ? [args.increaseAccountId]
      : (
          await ctx.runQuery(
            internal.increase.listProvisionedIncreaseAccounts,
            {},
          )
        ).map((a) => a.increaseAccountId);

    let scanned = 0;
    let inserted = 0;
    let accountsProcessed = 0;
    // Memoize card_payment_id → card_id across the whole run (many charges share
    // a card / card payment).
    const cardIdCache = new Map<string, string | null>();

    for (const accountId of accountIds) {
      const { key, base } = increaseEnvForObjectId(accountId);
      if (!key) {
        console.warn(
          `[increase] backfill skipped account ${accountId}: no API key for its environment`,
        );
        continue;
      }
      accountsProcessed += 1;

      let cursor: string | undefined = undefined;
      for (let page = 0; page < INCREASE_BACKFILL_MAX_PAGES; page++) {
        const params = new URLSearchParams();
        params.set("account_id", accountId);
        params.set("limit", String(INCREASE_PAGE_SIZE));
        if (cursor) params.set("cursor", cursor);

        let body: {
          data?: IncreaseTransactionLite[];
          next_cursor?: string | null;
        };
        try {
          const res = await fetch(`${base}/transactions?${params.toString()}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${key}` },
          });
          if (!res.ok) {
            console.error(
              `[increase] backfill: list failed for ${accountId}:`,
              await res.text(),
            );
            break;
          }
          body = (await res.json()) as {
            data?: IncreaseTransactionLite[];
            next_cursor?: string | null;
          };
        } catch (err) {
          console.error(
            `[increase] backfill: list error for ${accountId}:`,
            err,
          );
          break;
        }

        const rows = body.data ?? [];
        for (const row of rows) {
          scanned += 1;
          const charge = extractCardCharge(row);
          if (!charge) continue; // non-card row → skip
          const increaseCardId = await resolveIncreaseCardId(
            key,
            base,
            charge.cardPaymentId,
            cardIdCache,
          );
          const result = await ctx.runMutation(
            internal.increase.applyIncreaseCardTransaction,
            {
              externalId: charge.externalId,
              accountId: charge.accountId,
              flow: charge.flow,
              amountCents: charge.amountCents,
              currency: (row.currency ?? "usd").toLowerCase(),
              postedAt: charge.postedAt,
              merchantName: charge.merchantName,
              merchantCategory: charge.merchantCategory,
              increaseCardId: increaseCardId ?? undefined,
            },
          );
          if (result.inserted) inserted += 1;
        }

        cursor = body.next_cursor ?? undefined;
        if (!cursor || rows.length === 0) break;
      }
    }

    console.log(
      `[increase] card backfill complete: ${accountsProcessed} account(s), scanned ${scanned}, inserted ${inserted}`,
    );
    return { accounts: accountsProcessed, scanned, inserted };
  },
});

// ── onIncreaseWebhookEvent (internal mutation) — the payout state machine ─────

/**
 * Advance a payout from an Increase ACH-transfer signal. Fed by
 * `handleIncreaseWebhook` (which fetches the transfer to get `status`, since the
 * webhook event carries none); also called directly by tests. `eventType` is the
 * event `category` (`ach_transfer.created`/`.updated`), `status` the FETCHED
 * transfer status. Matches by `increaseTransferId` (the `by_increase_transfer`
 * index); no matching payout → no-op (never throws). Guards transitions: a `paid`
 * payout ignores a later `failed`/`returned`. On `paid` the reimbursement is
 * settled (`paid` + the offsetting `transfer` txn, idempotent); on
 * `failed`/`returned` the reimbursement walks back to `approved`.
 */
export const onIncreaseWebhookEvent = internalMutation({
  args: {
    eventType: v.string(),
    transferId: v.string(),
    status: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { eventType, transferId, status }) => {
    const payout = await ctx.db
      .query("payouts")
      .withIndex("by_increase_transfer", (q) =>
        q.eq("increaseTransferId", transferId),
      )
      .first();
    if (!payout) return null; // unknown transfer → no-op

    const target = payoutTargetFor(eventType, status);
    if (!target) return null;

    await applyPayoutOutcome(
      ctx,
      payout,
      target,
      target === "failed" || target === "returned" ? eventType : undefined,
    );
    return null;
  },
});

/**
 * Process an async Increase ACH-transfer webhook. The Standard-Webhooks event
 * carries only a `category` + `associated_object_id` (no inline status), so this
 * FETCHES the transfer (GET /ach_transfers/{id}) to read its real status, then
 * advances the matching payout via `onIncreaseWebhookEvent`. The orchestrator's
 * `/increase/webhook` route calls this for every non-`real_time_decision.*`
 * event (after de-duping on the event id). `ach_transfer.*` categories drive the
 * payout state machine; `transaction.created` ingests a settled card charge into
 * the ledger (`ingestIncreaseCardTransaction`); anything else no-ops. ONE endpoint
 * serves BOTH environments: the
 * follow-up fetch is routed by the object id's `sandbox_` prefix
 * (`increaseEnvForObjectId`) — sandbox objects hit the sandbox with
 * `INCREASE_SANDBOX_API_KEY`, production objects the deployment's own key.
 * DEGRADES to a logged no-op (never throws) when that environment's API key is
 * unset or the fetch fails.
 */
export const handleIncreaseWebhook = internalAction({
  args: { category: v.string(), associatedObjectId: v.string() },
  returns: v.null(),
  handler: async (ctx, { category, associatedObjectId }) => {
    // A settled card charge/refund → the `transactions` ledger. The Event carries
    // no inline object, so `ingestIncreaseCardTransaction` fetches the Transaction
    // (+ its Card Payment for attribution) and posts it (idempotent, best-effort).
    if (category === "transaction.created") {
      await ingestIncreaseCardTransaction(ctx, associatedObjectId);
      return null;
    }

    if (!category.startsWith("ach_transfer.")) return null;

    const { key, base } = increaseEnvForObjectId(associatedObjectId);
    if (!key) {
      console.warn(
        "[increase] webhook skipped: Increase API key not configured for this environment",
      );
      return null;
    }

    let status: string | undefined;
    try {
      const transfer = await increaseGet(
        key,
        base,
        `/ach_transfers/${associatedObjectId}`,
      );
      status = typeof transfer.status === "string" ? transfer.status : undefined;
    } catch (err) {
      console.error("[increase] webhook: failed to fetch ach_transfer", err);
      return null;
    }

    await ctx.runMutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: category,
      transferId: associatedObjectId,
      status,
    });
    return null;
  },
});

// ── verifyIncreaseSignature (webhook signature verify) ───────────────────────

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** The three Standard Webhooks headers Increase sends (`webhook-id`,
 *  `webhook-timestamp`, `webhook-signature`). The orchestrator reads them off
 *  the request and passes them here. */
export interface IncreaseWebhookHeaders {
  webhookId: string | null;
  webhookTimestamp: string | null;
  webhookSignature: string | null;
}

/**
 * Verify an Increase webhook signature per the Standard Webhooks spec
 * (https://increase.com/documentation/webhooks). Increase sends three headers:
 * `webhook-id`, `webhook-timestamp`, `webhook-signature`. The signed content is
 * `${webhook-id}.${webhook-timestamp}.${rawBody}`; the MAC is HMAC-SHA256,
 * base64-encoded. `webhook-signature` is one or more SPACE-separated
 * `v1,<base64sig>` tokens (multiple during key rotation) — we constant-time
 * compare against each. A ~5-minute timestamp tolerance guards replay. The
 * orchestrator calls this in `/increase/webhook`.
 *
 * KEY AMBIGUITY: Increase's webhook "Shared Secret" (a user-provided value) may
 * be used as the HMAC key EITHER raw (the secret's UTF-8 bytes) OR base64-decoded
 * (the Standard Webhooks `whsec_<base64>` convention). We can't know which, so we
 * try EVERY candidate key and accept if ANY produces a matching signature:
 *   - the raw secret bytes (`TextEncoder().encode(secret)`),
 *   - the raw bytes after stripping a `whsec_` prefix,
 *   - the base64-DECODED bytes of the secret (sans `whsec_`), when it decodes.
 */
export async function verifyIncreaseSignature(
  rawBody: string,
  headers: IncreaseWebhookHeaders,
  secret: string,
): Promise<boolean> {
  const { webhookId, webhookTimestamp, webhookSignature } = headers;
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  // Build the candidate HMAC keys (see KEY AMBIGUITY above). Each is a fresh
  // ArrayBuffer-backed copy so it's a valid `BufferSource` for `importKey`.
  const withoutPrefix = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const candidateKeys: Uint8Array<ArrayBuffer>[] = [
    new Uint8Array(new TextEncoder().encode(secret)),
  ];
  if (withoutPrefix !== secret) {
    candidateKeys.push(new Uint8Array(new TextEncoder().encode(withoutPrefix)));
  }
  try {
    candidateKeys.push(base64ToBytes(withoutPrefix));
  } catch {
    // Not valid base64 — skip the decoded-key candidate.
  }

  const signedContent = new TextEncoder().encode(
    `${webhookId}.${webhookTimestamp}.${rawBody}`,
  );
  const tokens = webhookSignature.split(" ");

  for (const keyBytes of candidateKeys) {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, signedContent),
    );
    const expected = bytesToBase64(mac);

    // `webhook-signature` = space-separated `v1,<base64sig>` tokens.
    for (const token of tokens) {
      const comma = token.indexOf(",");
      if (comma === -1) continue;
      const version = token.slice(0, comma);
      const candidate = token.slice(comma + 1);
      if (version !== "v1") continue;
      if (candidate.length !== expected.length) continue;
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
      }
      if (diff === 0) return true;
    }
  }
  return false;
}

// ── listPayouts (query, viewer) ──────────────────────────────────────────────

/** The caller's chapter's payouts (viewer+), newest first. The read shape the
 *  reimbursement/payout UI renders. */
export const listPayouts = query({
  args: {},
  returns: v.array(payoutSummaryValidator),
  handler: async (ctx): Promise<PayoutSummary[]> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");

    // Filter to the current environment: a `sandbox_`-prefixed transfer id is a
    // sandbox payout (hidden in production mode, shown in sandbox mode). A NULL
    // transfer id is a manual/degraded payout (env-neutral) — always shown.
    const sandboxMode = await readSandbox(ctx);
    const payouts = (
      await ctx.db
        .query("payouts")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .order("desc")
        .take(200)
    ).filter((p) => matchesMode(p.increaseTransferId ?? null, sandboxMode));
    return payouts.map(toPayoutSummary);
  },
});

// ── getChapterAccount (query, viewer) ────────────────────────────────────────

/** The caller's chapter's Increase Account summary for the CURRENT mode
 *  (viewer+), or null if none has been provisioned in this environment yet. The
 *  off-mode account (e.g. a leftover sandbox account while in production) is
 *  hidden — a null return drives the "Provision account" trigger. */
export const getChapterAccount = query({
  args: {},
  returns: v.union(increaseAccountSummaryValidator, v.null()),
  handler: async (ctx): Promise<IncreaseAccountSummary | null> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return null;
    await requireFinanceRole(ctx, chapterId, "viewer");

    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    return account ? toAccountSummary(account) : null;
  },
});

// ── listAccountsStatus (query, ED/FM only — WP-1.2) ──────────────────────────

/**
 * The read-only Increase account status list (WP-1.2): one row per scope —
 * every chapter, plus `"central"` — with its CURRENT-mode account (or `null`
 * if not yet provisioned). Backs the Accounts tab's "quiet status/audit view"
 * now that provisioning is fully automatic; there's nothing left to DO here,
 * only to see. ED/FM-only (`requireCentralEdOrFm` — tighter than the old
 * central-scope manager gate); everyone else, including chapter finance
 * managers, gets a `FORBIDDEN` `ConvexError`.
 */
export const listAccountsStatus = query({
  args: {},
  returns: v.array(
    v.object({
      scope: financeScopeValidator,
      scopeName: v.string(),
      account: v.union(increaseAccountSummaryValidator, v.null()),
    }),
  ),
  handler: async (ctx) => {
    await requireCentralEdOrFm(ctx);

    const sandboxMode = await readSandbox(ctx);
    const chapters = (await ctx.db.query("chapters").collect())
      .filter((c) => c.isActive !== false)
      .sort((a, b) => a.name.localeCompare(b.name));

    const scopes: { scope: FinanceScope; scopeName: string }[] = [
      { scope: "central", scopeName: CENTRAL_ACCOUNT_NAME },
      ...chapters.map((c) => ({ scope: c._id, scopeName: c.name })),
    ];

    const rows = [];
    for (const { scope, scopeName } of scopes) {
      const account = await getChapterAccountForMode(ctx, scope, sandboxMode);
      rows.push({
        scope,
        scopeName,
        account: account ? toAccountSummary(account) : null,
      });
    }
    return rows;
  },
});

// ── removeChapterAccount (mutation, manager) ─────────────────────────────────

/**
 * Delete the chapter's `increaseAccounts` row. Manager-only. Used to clear a
 * STALE TEST account — a `sandbox_`-prefixed account left behind after the
 * deployment was flipped from sandbox back to production mode — so the manager
 * can provision the real production account fresh (via `provisionChapterAccount`).
 *
 * SAFETY: refuses to remove a LIVE production account (active + a non-`sandbox_`
 * `increaseAccountId`) — that row maps to a real Increase Account holding the
 * chapter's money; dropping it would orphan the balance. Removing a pending row
 * (never fully provisioned) or a sandbox test row is always allowed. Idempotent:
 * a no-op (returns) when there's no row. Does NOT auto-provision a replacement.
 *
 * CASCADE: removing a sandbox/test account also deletes the chapter's leftover
 * SANDBOX child records so the chapter is clean for a fresh production
 * provision — `sandbox_`-issued `cards` (+ their `cardAuthorizations`),
 * `sandbox_` `payouts`, any `increase_*` `transactions` with a `sandbox_`
 * external/source id, AND any `skim`/`launch_grant`/`settlement` TRANSFER leg
 * (WP-4.1/4.2/4.5) whose `externalId` is `sandbox_`-prefixed — otherwise a sandbox-initiated
 * transfer would keep counting toward the PRODUCTION City Launch Fund position
 * forever (`dashboardCentral`). Environment-NEUTRAL records (a null-id
 * degraded card, a manual null-transfer payout, a manually-recorded transfer
 * leg with no `externalId`) are left untouched. Best-effort Increase-side card
 * cancellation is OUT OF SCOPE — this only cleans our DB (a sandbox object is
 * disposable at the vendor anyway). Idempotent.
 */
export const removeChapterAccount = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    // Remove the account for the CURRENT mode — the one the UI shows. The
    // off-mode account (if any) is left untouched.
    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    if (!account) return null; // nothing to remove (idempotent)

    const isLiveProductionAccount =
      account.onboardingStatus === "active" &&
      !!account.increaseAccountId &&
      !account.increaseAccountId.startsWith("sandbox_");
    if (isLiveProductionAccount) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message:
          "This is the chapter's live production account — it can't be removed here.",
      });
    }

    // Cascade: drop the chapter's leftover SANDBOX child records. Bounded scans
    // (these per-chapter tables are small); env-neutral null-id records survive.
    const CASCADE_SCAN_LIMIT = 5000;

    // 1. Sandbox cards + their authorizations.
    const cards = await ctx.db
      .query("cards")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CASCADE_SCAN_LIMIT);
    for (const card of cards) {
      if (!isSandboxObjectId(card.increaseCardId)) continue; // keep null/prod
      const auths = await ctx.db
        .query("cardAuthorizations")
        .withIndex("by_card", (q) => q.eq("cardId", card._id))
        .take(CASCADE_SCAN_LIMIT);
      for (const a of auths) await ctx.db.delete(a._id);
      await ctx.db.delete(card._id);
    }

    // 2. Sandbox payouts (a NULL transfer id is a manual payout → NOT deleted).
    const payouts = await ctx.db
      .query("payouts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CASCADE_SCAN_LIMIT);
    for (const p of payouts) {
      if (isSandboxObjectId(p.increaseTransferId)) await ctx.db.delete(p._id);
    }

    // 3. Sandbox increase_* transactions (none written today — defensive). A
    //    reimbursement/repayment/manual txn is env-neutral and left alone.
    //    ALSO sandbox skim/launch_grant/settlement TRANSFER legs (WP-4.1/4.2/4.5)
    //    — a sandbox-initiated `initiateSkimTransfer`/`initiateLaunchGrant`/
    //    `initiateSettlementTransfer` stamps the leg's `externalId` with the
    //    real Increase account-transfer id (`sandbox_account_transfer_…` in
    //    sandbox), so it's matched by prefix the same way a card/ACH row is;
    //    otherwise it would count toward the PRODUCTION City Launch Fund
    //    position forever (dashboardCentral).
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CASCADE_SCAN_LIMIT);
    for (const t of txns) {
      const isIncreaseTxn =
        t.source === "increase_card" || t.source === "increase_ach";
      const isTransferTxn =
        t.source === "skim" ||
        t.source === "launch_grant" ||
        t.source === "settlement";
      if (
        (isIncreaseTxn &&
          (isSandboxObjectId(t.externalId) ||
            isSandboxObjectId(t.sourceAccountId))) ||
        (isTransferTxn && isSandboxObjectId(t.externalId))
      ) {
        await ctx.db.delete(t._id);
      }
    }

    await ctx.db.delete(account._id);
    return null;
  },
});

// ── runBackfillIncreaseAccountEnv (internalMutation, CLI/CI) ──────────────────

/**
 * Backfill the `sandbox` environment field on existing `increaseAccounts` rows
 * from their `increaseAccountId` prefix (`isSandboxObjectId`) — a `sandbox_` id
 * is a sandbox account, everything else (incl. a null/pending id) is production.
 *
 * ONLY stamps LEGACY rows that predate the field (`sandbox === undefined`); rows
 * already carrying an explicit value are the source of truth and left untouched,
 * which makes this idempotent (a second run stamps nothing).
 *
 * CLI-runnable (no auth gate — an internalMutation isn't publicly callable):
 *   npx convex run increase:runBackfillIncreaseAccountEnv
 * On prod via the workflow:
 *   gh workflow run run-convex-function.yml -f function=increase:runBackfillIncreaseAccountEnv
 */
export const runBackfillIncreaseAccountEnv = internalMutation({
  args: {},
  returns: v.object({ scanned: v.number(), updated: v.number() }),
  handler: async (ctx): Promise<{ scanned: number; updated: number }> => {
    const rows = await ctx.db.query("increaseAccounts").collect();
    let updated = 0;
    for (const row of rows) {
      if (row.sandbox !== undefined) continue; // already stamped (source of truth)
      await ctx.db.patch(row._id, {
        sandbox: isSandboxObjectId(row.increaseAccountId),
      });
      updated += 1;
    }
    return { scanned: rows.length, updated };
  },
});

// ── Digital Card Profile — PW card art pipeline (WP-C.2) ─────────────────────
//
// Four ops steps, run in order once real card art exists (the final PNG with
// the Visa logo placed is an owner/designer step — this pipeline just takes
// any conforming PNG):
//   1. `uploadCardArtAssets`   — POST /files (card art 1536x969 + a 100x100
//                                icon), stores the returned file ids.
//   2. `createDigitalCardProfile` — POST /digital_card_profiles from those
//                                file ids, stores the returned profile id
//                                (status starts "pending").
//   3. `refreshCardArtProfileStatus` — GET /digital_card_profiles/{id},
//                                stores whatever review status Increase (and/
//                                or the card network) currently reports. Run
//                                this repeatedly until it logs "active".
//   4. `backfillCardProfiles` — PATCH /cards/{id} on every existing
//                                non-canceled card to attach the profile;
//                                new cards get it automatically at issuance
//                                (`cards.ts`'s `issueCard`, via
//                                `getCardArtProfileId`). Both this step and
//                                issuance only ever attach a profile whose
//                                stored status is "active" — a pending or
//                                rejected profile attaches to nothing.
// All four are MODE-AWARE and DEGRADE (log + return, never throw) when the
// relevant environment's Increase key isn't configured — same discipline as
// `runProvisionFlow`.

/** The review states Increase's Digital Card Profile process moves through —
 *  `GET /digital_card_profiles/{id}`'s `status` field. Anything Increase
 *  returns that ISN'T `"active"`/`"rejected"` is treated as still `"pending"`
 *  (`normalizeCardArtProfileStatus`) — a conservative default, since only
 *  `"active"` ever unlocks attaching the profile to a card. */
type CardArtProfileStatus = "pending" | "active" | "rejected";

function normalizeCardArtProfileStatus(raw: unknown): CardArtProfileStatus {
  return raw === "active" || raw === "rejected" ? raw : "pending";
}

/** Read the current mode's card-art config (file ids + profile id/status, if
 *  minted) off the `financeSettings` singleton. Shared by `getCardArtFileIds`,
 *  `getCardArtProfileId`, and `getCardArtProfileRecord` below. */
async function readCardArtConfig(
  ctx: { db: QueryCtx["db"] },
  sandbox: boolean,
): Promise<{
  fileId: string;
  iconFileId: string;
  profileId?: string;
  profileStatus?: CardArtProfileStatus;
} | null> {
  const settings = await ctx.db.query("financeSettings").first();
  const config = sandbox ? settings?.cardArtSandbox : settings?.cardArt;
  return config ?? null;
}

/**
 * Store the given environment's freshly-uploaded file ids on the
 * `financeSettings` singleton. Upserts the row (mirrors `financeSettings.ts`'s
 * own `setSandboxMode`) — a fresh deployment may not have run that mutation
 * yet. Deliberately does NOT touch `profileId`: a re-upload only refreshes the
 * file ids, leaving any previously-minted profile in place (now stale, but a
 * profile is immutable — `createDigitalCardProfile` mints a fresh one from the
 * new ids when explicitly re-run).
 */
export const finishUploadCardArtAssets = internalMutation({
  args: { sandbox: v.boolean(), fileId: v.string(), iconFileId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sandbox, fileId, iconFileId }): Promise<null> => {
    const existing = await ctx.db.query("financeSettings").first();
    const key: "cardArt" | "cardArtSandbox" = sandbox ? "cardArtSandbox" : "cardArt";
    const prior = existing
      ? sandbox
        ? existing.cardArtSandbox
        : existing.cardArt
      : undefined;
    const patch = {
      [key]: {
        fileId,
        iconFileId,
        profileId: prior?.profileId,
        profileStatus: prior?.profileStatus,
      },
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        ...patch,
      });
    }
    return null;
  },
});

/**
 * Upload the two Digital Wallet card-art assets (WP-C.2) to Increase's Files
 * API and store the returned file ids. Args are base64-encoded PNG bytes (no
 * `data:` prefix) so this is workflow-passable (`run-convex-function.yml` can
 * pass string args) without ever putting the image bytes in the repo.
 * `cardArtBase64` must be the 1536x969 landscape card image; `iconBase64` the
 * 100x100 app icon (both PNG, both grounded against increase.com/documentation
 * /card-art). MODE-AWARE: targets whichever environment the live
 * `financeSettings.sandboxMode` toggle points at (same as `runProvisionFlow`)
 * — flip it before running to target sandbox vs. production. DEGRADES (logs +
 * returns null ids) when that environment's Increase key is unset.
 *
 * CLI/CI-runnable:
 *   npx convex run increase:uploadCardArtAssets -- '{"cardArtBase64":"...","iconBase64":"..."}'
 */
export const uploadCardArtAssets = internalAction({
  args: { cardArtBase64: v.string(), iconBase64: v.string() },
  returns: v.object({
    sandbox: v.boolean(),
    fileId: v.union(v.string(), v.null()),
    iconFileId: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    { cardArtBase64, iconBase64 },
  ): Promise<{
    sandbox: boolean;
    fileId: string | null;
    iconFileId: string | null;
  }> => {
    const sandbox = await ctx.runQuery(
      internal.financeSettings.readSandboxMode,
      {},
    );
    const { key, base } = increaseEnvForMode(sandbox);
    if (!key) {
      console.warn(
        `[increase] uploadCardArtAssets skipped: Increase API key not configured for ${sandbox ? "sandbox" : "production"}`,
      );
      return { sandbox, fileId: null, iconFileId: null };
    }

    const fileId = await increasePostFile(
      key,
      base,
      cardArtBase64,
      "card-art.png",
      "digital_wallet_artwork",
    );
    const iconFileId = await increasePostFile(
      key,
      base,
      iconBase64,
      "card-icon.png",
      "digital_wallet_app_icon",
    );
    await ctx.runMutation(internal.increase.finishUploadCardArtAssets, {
      sandbox,
      fileId,
      iconFileId,
    });
    console.log(
      `[increase] uploadCardArtAssets: stored ${sandbox ? "sandbox" : "production"} file ids (art=${fileId}, icon=${iconFileId})`,
    );
    return { sandbox, fileId, iconFileId };
  },
});

/** Patch the freshly-minted Digital Card Profile id onto the current mode's
 *  config — the `profileId` field of the schema's card-art config shape; the
 *  file ids are already set by `finishUploadCardArtAssets` and untouched
 *  here. A fresh profile always starts `profileStatus: "pending"` — Increase
 *  hasn't reviewed it yet; `refreshCardArtProfileStatus` is the only thing
 *  that ever advances it to `"active"`/`"rejected"`. */
export const finishCreateDigitalCardProfile = internalMutation({
  args: { sandbox: v.boolean(), profileId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sandbox, profileId }): Promise<null> => {
    const existing = await ctx.db.query("financeSettings").first();
    const prior = sandbox ? existing?.cardArtSandbox : existing?.cardArt;
    if (!existing || !prior) {
      // Shouldn't happen (createDigitalCardProfile only reaches here once
      // uploadCardArtAssets already stored file ids) — log and no-op rather
      // than insert a config row with no file ids.
      console.error(
        "[increase] finishCreateDigitalCardProfile: no card-art file ids on record — skipping",
      );
      return null;
    }
    const key: "cardArt" | "cardArtSandbox" = sandbox ? "cardArtSandbox" : "cardArt";
    await ctx.db.patch(existing._id, {
      [key]: { ...prior, profileId, profileStatus: "pending" },
    });
    return null;
  },
});

/**
 * Create the Digital Card Profile (WP-C.2) from the current mode's uploaded
 * file ids — `POST /digital_card_profiles`, grounded against
 * `increase-typescript`'s `DigitalCardProfileCreateParams`: required
 * `background_image_file_id` (the card art), `app_icon_file_id`,
 * `card_description` + `issuer_name` (both "Public Worship" — the app-facing
 * name shown in the wallet) and an internal `description`; `text_color`
 * defaults to white but is set explicitly per the PRD ({red,green,blue}:255).
 *
 * The profile comes back `status:"pending"` — Increase (and/or the card
 * network) reviews it before it can be assigned to cards; see the PR
 * description for that process. MODE-AWARE / DEGRADES like
 * `uploadCardArtAssets`; additionally degrades (logs + returns null) when
 * this mode has no uploaded file ids yet.
 *
 * CLI/CI-runnable: npx convex run increase:createDigitalCardProfile
 */
export const createDigitalCardProfile = internalAction({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const sandbox = await ctx.runQuery(
      internal.financeSettings.readSandboxMode,
      {},
    );
    const { key, base } = increaseEnvForMode(sandbox);
    if (!key) {
      console.warn(
        `[increase] createDigitalCardProfile skipped: Increase API key not configured for ${sandbox ? "sandbox" : "production"}`,
      );
      return null;
    }
    const config = await ctx.runQuery(internal.increase.getCardArtFileIds, {
      sandbox,
    });
    if (!config) {
      console.warn(
        `[increase] createDigitalCardProfile skipped: no card-art file ids uploaded yet for ${sandbox ? "sandbox" : "production"} — run uploadCardArtAssets first`,
      );
      return null;
    }

    const profile = await increasePost(key, base, "/digital_card_profiles", {
      background_image_file_id: config.fileId,
      app_icon_file_id: config.iconFileId,
      card_description: "Public Worship",
      issuer_name: "Public Worship",
      description: "Public Worship — card art (WP-C.2)",
      text_color: { red: 255, green: 255, blue: 255 },
    });
    const profileId =
      typeof profile.id === "string" && profile.id ? profile.id : null;
    if (!profileId) {
      console.error(
        "[increase] createDigitalCardProfile: response carried no usable id; raw response:",
        JSON.stringify(profile),
      );
      return null;
    }
    await ctx.runMutation(internal.increase.finishCreateDigitalCardProfile, {
      sandbox,
      profileId,
    });
    console.log(
      `[increase] createDigitalCardProfile: created ${profileId} (status=${String(profile.status ?? "unknown")}) for ${sandbox ? "sandbox" : "production"}`,
    );
    return profileId;
  },
});

/** The current mode's uploaded card-art file ids (action-facing — actions have
 *  no `ctx.db`). Null when nothing's been uploaded yet for that mode. */
export const getCardArtFileIds = internalQuery({
  args: { sandbox: v.boolean() },
  returns: v.union(
    v.object({ fileId: v.string(), iconFileId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { sandbox }) => {
    const config = await readCardArtConfig(ctx, sandbox);
    return config ? { fileId: config.fileId, iconFileId: config.iconFileId } : null;
  },
});

/**
 * The current mode's Digital Card Profile id, if one has been minted AND
 * Increase has reviewed it as `"active"` — read by `cards.ts`'s `issueCard`
 * (mode from the account it's issuing on) and `backfillCardProfiles` below
 * (mode from each existing card's own id prefix). Null both when no profile
 * exists yet for that mode AND when one exists but is still `"pending"`/was
 * `"rejected"` — issuance/backfill then omit `digital_wallet` entirely rather
 * than attach a profile Increase hasn't cleared (which would otherwise
 * silently attach to every issued card with no signal it isn't really live).
 * Use `getCardArtProfileRecord` instead when the id is needed regardless of
 * status (`refreshCardArtProfileStatus` polling).
 */
export const getCardArtProfileId = internalQuery({
  args: { sandbox: v.boolean() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { sandbox }) => {
    const config = await readCardArtConfig(ctx, sandbox);
    return config?.profileId && config.profileStatus === "active"
      ? config.profileId
      : null;
  },
});

/**
 * The current mode's minted Digital Card Profile id + its last-known review
 * status, UNGATED (unlike `getCardArtProfileId` above, which only surfaces
 * the id once `profileStatus === "active"`). Used exclusively by
 * `refreshCardArtProfileStatus` below, which needs to know WHICH profile to
 * poll regardless of whether it's cleared review yet. Null when no profile
 * has been minted for this mode.
 */
export const getCardArtProfileRecord = internalQuery({
  args: { sandbox: v.boolean() },
  returns: v.union(
    v.object({
      profileId: v.string(),
      profileStatus: v.union(v.literal("pending"), v.literal("active"), v.literal("rejected")),
    }),
    v.null(),
  ),
  handler: async (ctx, { sandbox }) => {
    const config = await readCardArtConfig(ctx, sandbox);
    if (!config?.profileId) return null;
    return { profileId: config.profileId, profileStatus: config.profileStatus ?? "pending" };
  },
});

/** Patch the current mode's stored `profileStatus` — the result of
 *  `refreshCardArtProfileStatus`'s `GET /digital_card_profiles/{id}` poll. */
export const finishRefreshCardArtProfileStatus = internalMutation({
  args: {
    sandbox: v.boolean(),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("rejected")),
  },
  returns: v.null(),
  handler: async (ctx, { sandbox, status }): Promise<null> => {
    const existing = await ctx.db.query("financeSettings").first();
    const prior = sandbox ? existing?.cardArtSandbox : existing?.cardArt;
    if (!existing || !prior) {
      // Shouldn't happen (refreshCardArtProfileStatus only reaches here once
      // getCardArtProfileRecord already found a minted profile) — log and
      // no-op rather than insert a config row with no file ids.
      console.error(
        "[increase] finishRefreshCardArtProfileStatus: no card-art config on record — skipping",
      );
      return null;
    }
    const key: "cardArt" | "cardArtSandbox" = sandbox ? "cardArtSandbox" : "cardArt";
    await ctx.db.patch(existing._id, { [key]: { ...prior, profileStatus: status } });
    return null;
  },
});

/**
 * Ops step (WP-C.2, run repeatedly between `createDigitalCardProfile` and
 * `backfillCardProfiles`): poll Increase's review status for the current
 * mode's minted Digital Card Profile — `GET /digital_card_profiles/{id}` —
 * and store whatever status it currently reports. A profile starts
 * `"pending"`; Increase (and/or the card network) eventually resolves it to
 * `"active"` (safe to attach — `getCardArtProfileId` then starts returning
 * it) or `"rejected"` (re-upload art per Increase's feedback and re-mint via
 * `createDigitalCardProfile`). LOGS LOUDLY on every call, success or
 * skip/degrade — this is a manual ops poll the operator watches to know when
 * to move to the next step, not a background job. MODE-AWARE / DEGRADES like
 * the rest of the pipeline: no key configured, or no profile minted yet for
 * this mode, logs a warning and returns null rather than throwing.
 *
 * CLI/CI-runnable:
 *   npx convex run increase:refreshCardArtProfileStatus
 *   gh workflow run run-convex-function.yml -f function=increase:refreshCardArtProfileStatus
 */
export const refreshCardArtProfileStatus = internalAction({
  args: {},
  returns: v.union(
    v.object({
      profileId: v.string(),
      status: v.union(v.literal("pending"), v.literal("active"), v.literal("rejected")),
    }),
    v.null(),
  ),
  handler: async (
    ctx,
  ): Promise<{ profileId: string; status: CardArtProfileStatus } | null> => {
    const sandbox = await ctx.runQuery(
      internal.financeSettings.readSandboxMode,
      {},
    );
    const { key, base } = increaseEnvForMode(sandbox);
    if (!key) {
      console.warn(
        `[increase] refreshCardArtProfileStatus skipped: Increase API key not configured for ${sandbox ? "sandbox" : "production"}`,
      );
      return null;
    }
    const record = await ctx.runQuery(internal.increase.getCardArtProfileRecord, {
      sandbox,
    });
    if (!record) {
      console.warn(
        `[increase] refreshCardArtProfileStatus skipped: no Digital Card Profile minted yet for ${sandbox ? "sandbox" : "production"} — run createDigitalCardProfile first`,
      );
      return null;
    }

    const profile = await increaseGet(
      key,
      base,
      `/digital_card_profiles/${record.profileId}`,
    );
    const status = normalizeCardArtProfileStatus(profile.status);
    await ctx.runMutation(internal.increase.finishRefreshCardArtProfileStatus, {
      sandbox,
      status,
    });
    console.log(
      `[increase] refreshCardArtProfileStatus: ${record.profileId} (${sandbox ? "sandbox" : "production"}) is now "${status}" (raw Increase status: ${String(profile.status ?? "unknown")})`,
    );
    return { profileId: record.profileId, status };
  },
});

/** Every card (any chapter) eligible for the Digital Card Profile backfill: a
 *  real Increase card (`increaseCardId` set — a "legacy" Relay card has none
 *  and no vendor object to PATCH) that isn't canceled (a canceled card will
 *  never authorize again; attaching art to it is pointless). */
export const listCardsForArtBackfill = internalQuery({
  args: {},
  returns: v.array(
    v.object({ cardId: v.id("cards"), increaseCardId: v.string() }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("cards").collect();
    return rows
      .filter((c) => c.status !== "canceled" && !!c.increaseCardId)
      .map((c) => ({ cardId: c._id, increaseCardId: c.increaseCardId! }));
  },
});

/**
 * Ops backfill (WP-C.2): attach the Digital Card Profile to every existing
 * non-canceled card (new cards get it at issuance instead — see
 * `cards.ts`'s `issueCard`). `PATCH /cards/{id}` with `digital_wallet:
 * {digital_card_profile_id}`, grounded against the Increase Cards resource's
 * update endpoint (confirmed digital_wallet IS patchable, not create-only).
 *
 * Each card is routed to ITS OWN environment by its `increaseCardId` prefix
 * (`increaseEnvForObjectId`) and reads THAT environment's profile id — a
 * sandbox card never gets the production profile id or vice versa. A card
 * whose environment has no minted profile yet, or no configured key, is
 * SKIPPED (not an error) — re-running the backfill after `uploadCardArtAssets`
 * + `createDigitalCardProfile` for that environment picks it up. Idempotent:
 * PATCHing the same `digital_card_profile_id` twice is a no-op on Increase's
 * side, so a re-run is always safe.
 *
 * CLI/CI-runnable:
 *   npx convex run increase:backfillCardProfiles
 *   gh workflow run run-convex-function.yml -f function=increase:backfillCardProfiles
 */
export const backfillCardProfiles = internalAction({
  args: {},
  returns: v.object({
    eligible: v.number(),
    patched: v.number(),
    skipped: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{ eligible: number; patched: number; skipped: number }> => {
    const cards = await ctx.runQuery(
      internal.increase.listCardsForArtBackfill,
      {},
    );
    let patched = 0;
    let skipped = 0;
    // One profile-id lookup per environment for the whole run — every card in
    // the same environment shares the same config.
    const profileIdByMode = new Map<boolean, string | null>();

    for (const c of cards) {
      const sandbox = isSandboxObjectId(c.increaseCardId);
      if (!profileIdByMode.has(sandbox)) {
        profileIdByMode.set(
          sandbox,
          await ctx.runQuery(internal.increase.getCardArtProfileId, {
            sandbox,
          }),
        );
      }
      const profileId = profileIdByMode.get(sandbox) ?? null;
      if (!profileId) {
        skipped += 1;
        continue;
      }
      const { key, base } = increaseEnvForObjectId(c.increaseCardId);
      if (!key) {
        console.warn(
          `[increase] backfillCardProfiles: skipped card ${c.increaseCardId} — no Increase key for its environment`,
        );
        skipped += 1;
        continue;
      }
      try {
        await increasePatch(key, base, `/cards/${c.increaseCardId}`, {
          digital_wallet: { digital_card_profile_id: profileId },
        });
        patched += 1;
      } catch (err) {
        console.error(
          `[increase] backfillCardProfiles: PATCH failed for card ${c.increaseCardId}:`,
          err,
        );
        skipped += 1;
      }
    }
    return { eligible: cards.length, patched, skipped };
  },
});
