import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";
import { splitPersonName } from "@events-os/shared";

/**
 * Structured-name backfill (founder ask, 2026-07-25): stamp
 * `people.firstName`/`lastName` onto every existing row whose display `name`
 * splits UNAMBIGUOUSLY — exactly two whitespace tokens, the one rule
 * `@events-os/shared#names#splitPersonName` defines (shared with every rename
 * write-through and the contacts import, so the halves can never disagree
 * about what "splittable" means). Anything else — single-word names,
 * three-plus tokens ("Ama (Gina) Oppong Asante"), parentheticals — is left
 * UNSET and counted (`skippedAmbiguous`): guessing which middle tokens belong
 * to which half would mislabel real people's names, and the founder's own
 * scoping was "when we can". `name` itself is never touched — it stays the
 * canonical display string everywhere.
 *
 * IDEMPOTENT: rows that already carry a `firstName` are skipped
 * (`skippedAlreadySplit`) — a re-run never overwrites a hand-corrected split
 * (someone fixing "Mary Jo" | "Van Der Berg" by hand must stay fixed).
 *
 * ============================================================================
 * ONE `.paginate()` PER INVOCATION — same rule as 0040-0042 (see 0041's
 * banner). First page inside `runPending`'s transaction; the rest drains via
 * `internal.migrations.continueSplitPersonNames`. No nested reads at all
 * (pure per-row compute + patch), so 0040's PAGE_SIZE of 200 is comfortable:
 * reads(page) = 200. Writes(page) ≤ 200.
 * ============================================================================
 */
const PAGE_SIZE = 200;

export type SplitPersonNamesPageResult = {
  scanned: number;
  split: number;
  skippedAlreadySplit: number;
  skippedAmbiguous: number;
  isDone: boolean;
  continueCursor: string | null;
};

/** Process exactly ONE page — exactly one `.paginate()` call. `pageSize` is a
 *  TEST-ONLY override, same convention as 0040-0042. */
export async function runSplitPersonNamesPage(
  ctx: MutationCtx,
  cursor: string | null,
  pageSize?: number,
): Promise<SplitPersonNamesPageResult> {
  const page = await ctx.db.query("people").paginate({ numItems: pageSize ?? PAGE_SIZE, cursor });

  const result = { scanned: 0, split: 0, skippedAlreadySplit: 0, skippedAmbiguous: 0 };
  for (const person of page.page) {
    result.scanned++;
    if (person.firstName !== undefined) {
      result.skippedAlreadySplit++;
      continue;
    }
    const halves = splitPersonName(person.name);
    if (!halves) {
      result.skippedAmbiguous++;
      continue;
    }
    await ctx.db.patch(person._id, halves);
    result.split++;
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.migrations.continueSplitPersonNames, {
      cursor: page.continueCursor,
    });
  }

  return {
    ...result,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

/** Registry entry point — first page only; the scheduled continuation drains
 *  the rest (same shape as 0040-0042, safe for the same idempotence reason). */
export async function runSplitPersonNames(ctx: MutationCtx) {
  return await runSplitPersonNamesPage(ctx, null);
}

export const splitPersonNames: Migration = {
  name: "0043_split_person_names",
  run: runSplitPersonNames,
};
