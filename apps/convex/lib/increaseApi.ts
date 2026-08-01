/**
 * Increase API plumbing shared by every `increase*` module: environment
 * resolution (prod vs sandbox, per object id or per runtime mode), the raw
 * fetch helpers (no SDK), Program resolution, account name matching, and the
 * ACH destination input validators.
 *
 * PURE HELPERS ONLY — nothing in `lib/` registers Convex functions, so moving
 * code here never changes a function path. The registered functions live in
 * the `apps/convex/increase*.ts` modules (see `increase.ts`'s header for the
 * module map).
 */
import { ConvexError } from "convex/values";

/** Increase API base URL. Env-overridable so dev/staging point at the sandbox
 *  (`INCREASE_API_BASE=https://sandbox.increase.com`); defaults to production. */
export function increaseApiBase(): string {
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

/**
 * Build a diagnostic suffix from an Increase error HTTP response: the status
 * code plus, when the body is Increase's JSON error shape
 * (`{type, title, detail}`), its `title`/`detail`. Parsed DEFENSIVELY — the body
 * may not be JSON (proxy/HTML error pages), in which case the status stands
 * alone. NEVER includes the API key or Authorization header — only the status
 * and the server-provided error text. Example: `HTTP 401: API key is invalid`.
 */
export function describeIncreaseError(status: number, bodyText: string): string {
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
export async function increasePost(
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
export async function increaseGet(
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

/**
 * Build a card's `digital_wallet` object — the thing that decides whether the
 * card can be added to Apple/Google Pay AT ALL.
 *
 * Increase gates wallet tokenization on ONE of two things being true (grounded
 * against `CardCreateParams.DigitalWallet` in the `increase` SDK: "To add a
 * card to a digital wallet, you may supply an email or phone number.
 * Alternatively, you can subscribe to and action a Real Time Decision with the
 * category `digital_wallet_token_requested` or
 * `digital_wallet_authentication_requested`"):
 *   (a) the card carries a `digital_wallet.email` / `.phone` contact, so
 *       Increase itself sends the verification one-time passcode, OR
 *   (b) a `Real-time decision` webhook subscription exists and we action those
 *       two RTD categories ourselves (`cards.ts`'s
 *       `handleIncreaseDigitalWalletTokenRequested` /
 *       `...AuthenticationRequested`).
 * We satisfy (a) UNCONDITIONALLY — the RTD handlers for (b) are written and
 * deployed, but they only ever fire once the webhook subscription is created
 * in the Increase dashboard, and until then a card with no contact on it
 * CANNOT be added to a wallet at all. Path (a) needs no dashboard step, so it
 * is what actually makes "Add to Apple Wallet" work; (b) then supersedes it
 * for free (Increase prefers the RTD when a subscription exists), which is why
 * both are safe to have on at once.
 *
 * EMAIL ONLY, never `phone` — the same constraint the RTD handlers document:
 * this deployment has no SMS provider, so offering a phone would let the wallet
 * pick an SMS one-time passcode we could never deliver. Every cardholder is
 * guaranteed an `@publicworship.life` address (`isCardEligible` gates
 * issuance), so the email is always available.
 *
 * `digitalCardProfileId` (WP-C.2 card art) is folded into the SAME object
 * because Increase takes `digital_wallet` as a whole: writing it with only one
 * of the two keys is what would drop the other. Every writer — `issueCard` and
 * the `backfillCardWallets` ops sweep — goes through here so the pair always
 * travels together.
 */
export function buildDigitalWallet(
  cardholderEmail: string,
  digitalCardProfileId: string | null,
): { email: string; digital_card_profile_id?: string } {
  return {
    email: cardholderEmail,
    ...(digitalCardProfileId
      ? { digital_card_profile_id: digitalCardProfileId }
      : {}),
  };
}

/** PATCH JSON to the Increase API (e.g. `PATCH /cards/{id}` to attach a
 *  Digital Card Profile — WP-C.2's `backfillCardWallets`). Throws ConvexError
 *  on a non-2xx (the caller logs + degrades). */
export async function increasePatch(
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

/** Resolve the Increase Program id to open a chapter Account under.
 *  `INCREASE_PROGRAM_ID` is an OPTIONAL explicit override — set it and it wins.
 *  Otherwise we fetch `GET /programs` and use the SOLE program, because a
 *  nonprofit has exactly ONE Increase Program (confirmed against both the live
 *  sandbox and production). Returns null (never throws) when there is no override
 *  AND `/programs` doesn't return exactly one program (0 or >1 → a clear warning),
 *  or on any fetch/parse error — the caller degrades to `pending`. The `base`
 *  is threaded through so a SANDBOX key hits the sandbox `/programs`. */
export async function resolveProgramId(
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
export interface IncreaseAccountLite {
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
export function pickMatchingAccount(
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
