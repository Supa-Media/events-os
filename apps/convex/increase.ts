/**
 * Increase — the native money layer for Chapter OS. THIS file is the webhook
 * ENTRY POINT (signature verify + event fan-out); the rest of the layer is
 * split by domain (each module ≤600 lines):
 *
 *   MODULE MAP
 *   - `increase.ts` (this file) — `/increase/webhook` verify + fan-out.
 *   - `increaseAccounts.ts` — the `increaseAccounts` rows: find-or-create,
 *     status queries, stale-test-account removal, env backfill.
 *   - `increaseProvision.ts` — opening/adopting Accounts under the shared org
 *     Entity (match-before-create, Program auto-resolution, link-by-id).
 *   - `increasePayouts.ts` — ACH reimbursement payouts + the payout state
 *     machine's webhook entry (`onIncreaseWebhookEvent`).
 *   - `increaseExternalAccounts.ts` — reusable ACH destinations
 *     (`POST /external_accounts`) for reimbursements + repayments.
 *   - `increaseLedger.ts` — transaction ingestion into the `transactions`
 *     ledger: card charges (`increase_card`) AND all other account activity
 *     (`increase_ach`), webhook-driven + daily backfill.
 *   - `increaseCardArt.ts` — the WP-C.2 Digital Card Profile pipeline.
 *   - `lib/increaseApi.ts` / `lib/increaseFiles.ts` / `lib/increaseShapes.ts` /
 *     `lib/increaseExtract.ts` / `lib/increasePayoutMachine.ts` — pure helpers
 *     (no registered functions, so no function paths live there).
 *
 * Increase is the source of truth for a chapter's balance: one shared org Entity
 * (`INCREASE_ENTITY_ID`); one Account per chapter + central (`increaseAccounts`),
 * member cards issued on it, and ACH reimbursement payouts (`payouts`)
 * originating from it. NO Stripe Issuing / Connect — Stripe FC
 * (`stripeFinance.ts`) only *reads* legacy accounts.
 *
 * Env: INCREASE_API_KEY, INCREASE_WEBHOOK_SECRET, INCREASE_ENTITY_ID (the shared
 * org Entity) — all required. INCREASE_PROGRAM_ID is an OPTIONAL override; the
 * Program is auto-resolved from `GET /programs` (a nonprofit has exactly one).
 * INCREASE_API_BASE is the sandbox URL for dev/staging (defaults to production).
 * INCREASE_SANDBOX_API_KEY (OPTIONAL): lets the single prod `/increase/webhook`
 * endpoint also serve sandbox webhooks — follow-up calls about a `sandbox_`-
 * prefixed object are routed to the sandbox with this key (see
 * `lib/increaseApi.ts#increaseEnvForObjectId`).
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { increaseEnvForObjectId, increaseGet } from "./lib/increaseApi";
import { verifyStandardWebhookSignature } from "./lib/standardWebhook";
import { ingestIncreaseTransaction } from "./increaseLedger";

// Convenient re-exports so long-standing imports (`http.ts`, `cards.ts`,
// `reimbursements.ts`, tests) keep reading from the family's front door.
export {
  increaseEnvForObjectId,
  increaseEnvForMode,
  assertRoutingNumber,
  assertAccountNumber,
} from "./lib/increaseApi";

/**
 * Process an async Increase webhook event. The Standard-Webhooks event carries
 * only a `category` + `associated_object_id` (no inline object/status), so the
 * handlers FETCH what they need:
 *  - `transaction.created` → `increaseLedger.ingestIncreaseTransaction`: fetch
 *    the Transaction and post it to the ledger — a settled card charge/refund
 *    lands as `increase_card`, ALL OTHER account activity (inbound/outbound
 *    ACH, wires, fees, interest, …) as `increase_ach`, so every entry on the
 *    account shows up in Reconcile (idempotent, best-effort).
 *  - `ach_transfer.*` → fetch the transfer (GET /ach_transfers/{id}) to read
 *    its real status, then advance the matching payout via
 *    `increasePayouts.onIncreaseWebhookEvent`.
 *  - anything else no-ops.
 * The orchestrator's `/increase/webhook` route calls this for every
 * non-`real_time_decision.*` event (after de-duping on the event id). ONE
 * endpoint serves BOTH environments: the follow-up fetch is routed by the
 * object id's `sandbox_` prefix (`increaseEnvForObjectId`) — sandbox objects
 * hit the sandbox with `INCREASE_SANDBOX_API_KEY`, production objects the
 * deployment's own key. DEGRADES to a logged no-op (never throws) when that
 * environment's API key is unset or the fetch fails.
 */
export const handleIncreaseWebhook = internalAction({
  args: { category: v.string(), associatedObjectId: v.string() },
  returns: v.null(),
  handler: async (ctx, { category, associatedObjectId }) => {
    if (category === "transaction.created") {
      await ingestIncreaseTransaction(ctx, associatedObjectId);
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

    await ctx.runMutation(internal.increasePayouts.onIncreaseWebhookEvent, {
      eventType: category,
      transferId: associatedObjectId,
      status,
    });
    return null;
  },
});

// ── verifyIncreaseSignature (webhook signature verify) ───────────────────────

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
  // Increase's webhooks ARE Standard Webhooks — the verification is identical
  // to Svix's (which is how Resend delivers inbound email), so both share the
  // one implementation in `lib/standardWebhook.ts` and can never drift. This
  // wrapper just maps Increase's `webhook-*` header names onto the generic
  // `{ id, timestamp, signature }` shape.
  return verifyStandardWebhookSignature(
    rawBody,
    {
      id: headers.webhookId,
      timestamp: headers.webhookTimestamp,
      signature: headers.webhookSignature,
    },
    secret,
  );
}
