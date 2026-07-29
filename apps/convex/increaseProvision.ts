/**
 * Increase account PROVISIONING — the network half of opening (or adopting) a
 * chapter's/central's Increase Account under the org's single shared Entity.
 * The find-or-create DB half lives in `increaseAccounts.ts`; this module owns
 * the `POST /accounts` flow, the ops backfill sweep, and the manual link-by-id
 * escape hatch. Part of the `increase*` module family (see `increase.ts`'s
 * header for the module map).
 *
 * SHARED-ENTITY MODEL: the org has ONE legal Increase Entity (the nonprofit),
 * KYB-verified ONCE in the Increase dashboard and referenced by
 * `INCREASE_ENTITY_ID`. This app NEVER creates entities and NEVER collects
 * KYB/PII — provisioning a chapter is just opening an Account under that shared
 * entity (`POST /accounts` with `entity_id` + `program_id` + a `name`).
 */
import {
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { readSandbox } from "./financeSettings";
import { requireChapterId } from "./lib/context";
import {
  requireFinanceManager,
  getChapterAccountForMode,
  type FinanceScope,
} from "./lib/finance";
import {
  increaseEnvForMode,
  increaseGet,
  increasePost,
  resolveProgramId,
  pickMatchingAccount,
  describeIncreaseError,
  type IncreaseAccountLite,
} from "./lib/increaseApi";
import {
  onboardingValidator,
  financeScopeValidator,
  increaseAccountSummaryValidator,
  toAccountSummary,
  type IncreaseAccountSummary,
  type BeginProvisionResult,
} from "./lib/increaseShapes";

/**
 * Shared provisioning body once `prep` (existing-or-provision, resolved by
 * `increaseAccounts.beginProvision` or the ops-only `beginProvisionForScope`)
 * is known. The SAME Idempotency-Key + match-before-create discipline applies
 * to every account — chapter or central — so this is the ONE place that logic
 * lives; reused by both `provisionChapterAccount` (caller-scoped) and
 * `provisionAccountForScope` (ops-only, WP-1.2 backfill /
 * auto-provision-at-creation).
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
    return await ctx.runMutation(internal.increaseAccounts.finishProvision, {
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
    return await ctx.runMutation(internal.increaseAccounts.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "pending",
    });
  }

  if (existingMatch) {
    console.log(
      `[increase] provision: LINKED existing account ${existingMatch.id} ("${existingMatch.name}") to chapter "${prep.chapterName}" — no new account created`,
    );
    return await ctx.runMutation(internal.increaseAccounts.finishProvision, {
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
    return await ctx.runMutation(internal.increaseAccounts.finishProvision, {
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
      return await ctx.runMutation(internal.increaseAccounts.finishProvision, {
        accountId: prep.accountId,
        onboardingStatus: "pending",
      });
    }
    console.log(
      `[increase] provision: CREATED account ${newAccountId} for chapter "${prep.chapterName}"`,
    );
    return await ctx.runMutation(internal.increaseAccounts.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "active",
      increaseEntityId: entityId!,
      increaseAccountId: newAccountId,
    });
  } catch (err) {
    // `increasePost` already logged the raw non-2xx body before throwing.
    console.error("[increase] provision: create failed:", err);
    return await ctx.runMutation(internal.increaseAccounts.finishProvision, {
      accountId: prep.accountId,
      onboardingStatus: "pending",
    });
  }
}

/**
 * Provision the CALLER'S OWN chapter's Increase Account under the org's single
 * shared Entity. Manager-only. Idempotent: an already-active account is
 * returned untouched. See `runProvisionFlow` for the shared body.
 *
 * OPS-ONLY (WP-1.2): provisioning is now a fully automatic backend sweep
 * (`backfillChapterAccounts` / scheduled at chapter creation) — the UI screen
 * that used to call this as a manager escape hatch was deleted in that PR.
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
      internal.increaseAccounts.beginProvision,
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
      internal.increaseAccounts.beginProvisionForScope,
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
 *   npx convex run increaseProvision:backfillChapterAccounts
 *   gh workflow run run-convex-function.yml -f function=increaseProvision:backfillChapterAccounts
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
    provisioned: {
      scope: string;
      status: IncreaseAccountSummary["onboardingStatus"];
    }[];
    skipped: string[];
  }> => {
    const chapterIds = await ctx.runQuery(
      internal.increaseProvision.listChapterIdsForBackfill,
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
        internal.increaseAccounts.beginProvisionForScope,
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
 * OPS-ONLY (WP-1.2): the manual-link UI was deleted along with
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
    const { sandbox } = await ctx.runMutation(
      internal.increaseProvision.beginLink,
      {},
    );
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
    return await ctx.runMutation(internal.increaseProvision.finishLink, {
      increaseAccountId: canonicalId,
      increaseEntityId: entityId,
      sandbox,
    });
  },
});
