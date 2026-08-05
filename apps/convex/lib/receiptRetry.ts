/**
 * AUTOMATIC re-extraction of a receipt whose OCR failed for a TRANSPORT
 * reason — the engine 500'd/429'd/timed out, so the read never happened at
 * all. Shared by the email pipeline (`receiptInbox.ts#runPipeline`), the
 * upload pipeline (`receipts.ts#runUploadPipeline`), and the retry action
 * itself (`receipts.ts#autoRetryExtraction`, which reschedules its own next
 * attempt), so all three agree on the schedule.
 *
 * WHY THIS EXISTS: an emailed screenshot came back
 * `AI request failed — Ollama returned HTTP 500 for model "gemma4"`, and the
 * receipt then just SAT there, red, until a human noticed and tapped Retry.
 * A 5xx is a blip on the engine's side, not a verdict on the receipt: the
 * pipeline already classifies it `ocrRetryable`, and the bulk sweep already
 * backs off and retries on it. The initial run was the one place that
 * recorded a transient failure as if it were final.
 *
 * Lives in `lib/` rather than in either pipeline so `receipts.ts` and
 * `receiptInbox.ts` can both schedule an attempt without importing each
 * other (they already share extraction one way round).
 */
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/** Something that can schedule — an action or a mutation ctx. Narrow on
 *  purpose: this module only ever needs `scheduler.runAfter`. */
export interface SchedulerCtx {
  scheduler: {
    runAfter: (
      delayMs: number,
      fn: typeof internal.receipts.autoRetryExtraction,
      args: { receiptId: Id<"receipts">; attempt: number },
    ) => Promise<unknown>;
  };
}

/**
 * Delay before attempt N (1-indexed): ~1min → 5min → 15min. Long enough that
 * a provider incident gets a real chance to clear between tries, short enough
 * that a receipt emailed at 9am isn't still unread at lunch. Three attempts
 * total (`AUTO_RETRY_MAX_ATTEMPTS`) — past ~20 minutes of solid failure this
 * is an outage or a misconfigured model, and the red card with the engine's
 * own message is the honest answer.
 */
export const AUTO_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const AUTO_RETRY_MAX_ATTEMPTS = AUTO_RETRY_DELAYS_MS.length;
/**
 * The attempt that switches to the FALLBACK OCR model
 * (`receiptInbox.ts#resolveFallbackOcrModel`). The first two attempts re-try
 * the configured model — a 500 usually IS transient. If it's still failing by
 * the last attempt, the model itself is the likeliest suspect (gemma4's
 * vision path 500s on ollama.com often enough to have caused this), so the
 * final attempt asks a DIFFERENT vision model rather than repeating a
 * question that has failed twice. The model that actually produced a read is
 * recorded on the receipt (`ocrModel`), so the provenance is never a guess.
 */
export const AUTO_RETRY_FALLBACK_ATTEMPT = AUTO_RETRY_MAX_ATTEMPTS;

/**
 * Schedule attempt `attempt` of the automatic re-extraction, or no-op once
 * the attempts are spent. A provider-declared `Retry-After` is honored as a
 * FLOOR (never shortens the backoff) — the same rule the bulk sweep follows.
 */
export async function scheduleAutoRetryExtraction(
  ctx: SchedulerCtx,
  receiptId: Id<"receipts">,
  attempt: number,
  retryAfterSeconds?: number,
): Promise<void> {
  if (attempt < 1 || attempt > AUTO_RETRY_MAX_ATTEMPTS) return;
  const base = AUTO_RETRY_DELAYS_MS[attempt - 1];
  const floor = (retryAfterSeconds ?? 0) * 1000;
  await ctx.scheduler.runAfter(
    Math.max(base, floor),
    internal.receipts.autoRetryExtraction,
    { receiptId, attempt },
  );
}
