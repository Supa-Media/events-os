/**
 * Increase External Accounts — the reusable ACH-destination primitive
 * (`POST /external_accounts`) shared by reimbursement bank-linking
 * (`reimbursements.ts`) and repayment bank-linking (`cards.ts`). Part of the
 * `increase*` module family (see `increase.ts`'s header for the module map).
 *
 * ACH DESTINATION CAPTURE: the reimbursement form (public + in-app) links a
 * REAL bank account via `linkPublicBankAccount` / `linkBankAccount`
 * (`reimbursements.ts`), which call `createExternalAccount` below and store
 * only its reusable reference id (`reimbursementRequests.externalAccountId`) +
 * a last-4 for display — the raw routing + account number are NEVER persisted.
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { EXTERNAL_ACCOUNT_FUNDINGS } from "@events-os/shared";
import { increaseEnvForMode, increasePost } from "./lib/increaseApi";

const externalAccountFundingValidator = v.union(
  ...EXTERNAL_ACCOUNT_FUNDINGS.map((f) => v.literal(f)),
);

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
 * MODE-AWARE like the rest of the family: uses the CURRENT
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
      // `/ach_transfers` elsewhere in this family): the natural key would be the
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
        description:
          args.accountHolderName.slice(0, 200) || "Reimbursement payee",
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
