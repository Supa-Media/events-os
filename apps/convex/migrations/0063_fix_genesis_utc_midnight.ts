import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";
import { isReconstructedHistory } from "@events-os/shared";

/**
 * Shift every RECONSTRUCTED-HISTORY transaction (`isReconstructedHistory` —
 * `historicalImportBatch` set, or `externalId` starting `"genesis-"`) that
 * still sits exactly on a UTC-midnight boundary forward by 12 hours, to noon
 * UTC.
 *
 * ── WHY UTC-MIDNIGHT WAS WRONG ────────────────────────────────────────────
 * `financeGenesisBackfill.ts#parseGenesisDate` used to stamp `postedAt` at
 * `Date.UTC(year, month, day)` — 00:00 UTC. The org's month bucketing is
 * `easternParts` (America/New_York), which is ALWAYS behind UTC (5h in
 * winter, 4h in summer), so 00:00 UTC on the 1st is 19:00 or 20:00 ET on the
 * PREVIOUS day. Every genesis row rendered one calendar day early in ET, and
 * a row dated the 1st of a month silently fell into the PRIOR month's
 * `finances.ts#monthCodingWorklist`, its dashboard totals, and — worst of
 * all — its public ledger snapshot (`lib/publicLedgerSnapshot.ts`), which
 * also buckets by `easternParts`. The live-code half of this fix
 * (`parseGenesisDate` now stamping noon UTC) only prevents new rows from
 * landing wrong; this migration is the one-time correction for the ~250
 * rows already written at the old boundary.
 *
 * ── WHY NOON UTC, AND WHY THE CHECK IS EXACT-BOUNDARY, NOT "EARLY IN THE
 * DAY" ──────────────────────────────────────────────────────────────────
 * Noon UTC is 07:00 ET (winter, UTC-5) or 08:00 ET (summer, UTC-4) — the one
 * hour of the day guaranteed to read as the SAME calendar date in both UTC
 * and US Eastern time regardless of DST, so shifting by exactly 12h is safe
 * for every row without inspecting which side of a DST transition it falls
 * on. The predicate is `postedAt % 86_400_000 === 0` (exactly UTC-midnight),
 * not a wider "before noon" window — a genesis row's true time-of-day is
 * unknowable (only a date was ever recorded), but only the UTC-midnight
 * stamp is a MISTAKE; anything else already has SOME chosen time-of-day
 * (e.g. this migration's own +12h, on a re-run) and must be left alone.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────
 * A row this migration has already shifted sits at `postedAt % 86_400_000
 * === 43_200_000` (noon), which never re-matches the exact-midnight
 * predicate — no separate "already patched" flag needed. A re-run (or the
 * ledger-skip racing a partial drain) just finds nothing left to touch.
 *
 * ── ALREADY-PUBLISHED MONTHS KEEP THEIR OLD BUCKETING, BY DESIGN ──────────
 * This migration only touches the LIVE `transactions` table. A month that
 * has already published freezes its `financePublicationEntries` rows
 * forever (`publicLedger.ts`'s module doc: "there is no unpublish") — this
 * is not the module that could touch them even if it wanted to, and it
 * shouldn't: a frozen month reads exactly what a human approved. If a
 * published month's figures need correcting for this reason, that is a
 * `startAmendment` → `publish` revision, made deliberately by a human, not a
 * side effect of a backend migration.
 *
 * ============================================================================
 * ONE `.paginate()` PER INVOCATION — same rule as every migration since 0040.
 * First page inside `runPending`'s transaction; the rest drains via
 * `internal.migrations.continueFixGenesisUtcMidnight`. Full-table scan (no
 * index on `historicalImportBatch`/`externalId`-prefix) — bounded per page,
 * same shape as 0045's `transactions` scan.
 * ============================================================================
 */
const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOON_SHIFT_MS = DAY_MS / 2;

export type FixGenesisUtcMidnightPageResult = {
  scanned: number;
  shifted: number;
  skippedNotGenesis: number;
  skippedNotMidnight: number;
  isDone: boolean;
  continueCursor: string | null;
};

/** Process exactly ONE page — exactly one `.paginate()` call. `pageSize` is a
 *  TEST-ONLY override, same convention as 0040-0045. */
export async function runFixGenesisUtcMidnightPage(
  ctx: MutationCtx,
  cursor: string | null,
  pageSize?: number,
): Promise<FixGenesisUtcMidnightPageResult> {
  const page = await ctx.db.query("transactions").paginate({
    numItems: pageSize ?? PAGE_SIZE,
    cursor,
  });

  const result = {
    scanned: 0,
    shifted: 0,
    skippedNotGenesis: 0,
    skippedNotMidnight: 0,
  };
  for (const txn of page.page) {
    if (!isReconstructedHistory(txn)) {
      result.skippedNotGenesis++;
      continue;
    }
    result.scanned++;
    if (txn.postedAt % DAY_MS !== 0) {
      result.skippedNotMidnight++;
      continue;
    }
    await ctx.db.patch(txn._id, { postedAt: txn.postedAt + NOON_SHIFT_MS });
    result.shifted++;
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.continueFixGenesisUtcMidnight,
      { cursor: page.continueCursor },
    );
  }

  return {
    ...result,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

/** Registry entry point — first page only; the scheduled continuation drains
 *  the rest (same shape as 0040-0045, safe for the same idempotence reason). */
export async function runFixGenesisUtcMidnight(ctx: MutationCtx) {
  return await runFixGenesisUtcMidnightPage(ctx, null);
}

export const fixGenesisUtcMidnight: Migration = {
  name: "0063_fix_genesis_utc_midnight",
  run: runFixGenesisUtcMidnight,
};
