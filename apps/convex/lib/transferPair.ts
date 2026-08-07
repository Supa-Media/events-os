/**
 * The central↔chapter transfer PAIR machinery — the double-entry choke point
 * every writer of transfer pairs goes through, factored out of `transfers.ts`
 * so `finances.ts` (manual payout allocation in `markAsPayout`) and
 * `reconciliation.ts` (the morning engine) can book pairs without importing
 * `transfers.ts` — which itself imports from `finances.ts` (cycle).
 *
 * LEDGER MODEL (see `transfers.ts`'s header for the history): every transfer
 * is a PAIR of `flow:"transfer"` transactions — an outflow leg on the source
 * scope + an inflow leg on the destination scope — linked by a shared
 * `transferGroupId`. Exactly two legs per group id, always (readers assume
 * it; see docs/plans/transfers-ops-notes.md).
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { CENTRAL, type AutoTransferOrigin } from "@events-os/shared";
import type { FinanceScope } from "./finance";

/** Which way a transfer moves money. A generic/manual transfer states it
 *  explicitly every time; the engine's pairs state it the same way. */
export const TRANSFER_DIRECTIONS = [
  "chapter_to_central",
  "central_to_chapter",
] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];

/** A transfer amount must be a positive whole number of cents (invariant #1). */
export function assertPositiveCents(
  amountCents: number,
  label = "Transfer amount",
): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} must be a positive whole number of cents.`,
    });
  }
}

/** Every transaction row carrying this `transferGroupId` (0, or the 2 legs). */
export async function transferPairLegs(
  ctx: QueryCtx,
  transferGroupId: string,
): Promise<Doc<"transactions">[]> {
  return await ctx.db
    .query("transactions")
    .withIndex("by_transfer_group", (q) =>
      q.eq("transferGroupId", transferGroupId),
    )
    .collect();
}

/** The source/dest scopes for a transfer pair, by direction. */
export function transferScopes(
  chapterId: Id<"chapters">,
  direction: TransferDirection,
): { sourceScope: FinanceScope; destScope: FinanceScope } {
  return direction === "central_to_chapter"
    ? { sourceScope: CENTRAL, destScope: chapterId }
    : { sourceScope: chapterId, destScope: CENTRAL };
}

export interface RecordPairArgs {
  sourceScope: FinanceScope;
  destScope: FinanceScope;
  amountCents: number;
  transferGroupId: string;
  postedAt: number;
  note?: string;
  transferDirection: TransferDirection;
  // Absent for an engine-booked pair (`reconciliation.ts` runs from a cron —
  // there is no human caller; `transferOrigin` says which process wrote it).
  userId?: Id<"users">;
  // Set by the morning reconciliation engine AND by `markAsPayout`'s manual
  // payout allocation; a plain `recordTransfer` pair leaves it absent. See
  // `AUTO_TRANSFER_ORIGINS` (`@events-os/shared`).
  transferOrigin?: AutoTransferOrigin;
}

/**
 * Insert the two `flow:"transfer"` legs (outflow on `sourceScope`, inflow on
 * `destScope`), both carrying the same `transferGroupId` and `source:"transfer"`.
 * REJECTS with `ALREADY_RECORDED` when a pair for that id already exists —
 * defense in depth against a `transferGroupId` collision for a manual
 * transfer (random ids), and the IDEMPOTENCY GUARD for deterministic ids
 * (`payoutalloc-…`/`autosettle-…`), which exist precisely so a re-run can
 * never book the same allocation twice. Returns the two leg ids.
 */
export async function recordTransferPair(
  ctx: MutationCtx,
  a: RecordPairArgs,
): Promise<{ outflowId: Id<"transactions">; inflowId: Id<"transactions"> }> {
  assertPositiveCents(a.amountCents);
  const existing = await transferPairLegs(ctx, a.transferGroupId);
  if (existing.length > 0) {
    throw new ConvexError({
      code: "ALREADY_RECORDED",
      message: "This transfer has already been recorded.",
    });
  }
  const now = Date.now();
  // Shared columns for both legs. `flow:"transfer"` → excluded from spend;
  // `status:"reconciled"` (it's a settled, fully-attributed movement, not a
  // charge awaiting review). `source:"transfer"` — every NEW transfer writes
  // this ONE source regardless of what it's for (see `transfers.ts`'s header
  // comment); the historical `skim`/`launch_grant`/`settlement` sources only
  // ever appear on rows written before the 2026-07-26 collapse.
  const shared = {
    source: "transfer" as const,
    flow: "transfer" as const,
    amountCents: a.amountCents,
    currency: "usd",
    postedAt: a.postedAt,
    description: a.note,
    transferGroupId: a.transferGroupId,
    transferDirection: a.transferDirection,
    transferOrigin: a.transferOrigin,
    status: "reconciled" as const,
    createdBy: a.userId,
    createdAt: now,
  };
  const outflowId = await ctx.db.insert("transactions", {
    chapterId: a.sourceScope,
    ...shared,
  });
  const inflowId = await ctx.db.insert("transactions", {
    chapterId: a.destScope,
    ...shared,
  });
  return { outflowId, inflowId };
}
