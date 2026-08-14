/**
 * ONE-SHOT catch-up: give every legacy `financeAuditLog` row the STATE KEY its
 * frozen words already implied.
 *
 * WHY IT EXISTS. Until 2026-08-14 the trail stored only display labels, frozen
 * at write time. #717 renamed the `reconciled` status's label from "Reconciled"
 * to "Closed" — the stored value never moved — and the history went half one
 * word and half the other about the identical state. The founder asked to
 * backdate the strings; he agreed to keys instead, verbatim: "Store the status
 * key and render the label." New rows carry `beforeKey`/`afterKey` from the
 * moment they're written (`lib/financeAuditLog.ts` refuses a keyed action
 * without them). This sweep is for everything written before that.
 *
 * ADDITIVE, NEVER REWRITING. `financeAuditLog` is APPEND-ONLY — "NEVER updated
 * or deleted once written" is the table's own schema contract, and the point of
 * the whole exercise was NOT falsifying what a bookkeeper saw. So this patches
 * in a field that was absent and touches nothing that was present: `before` and
 * `after` keep the exact words they were written with, forever. A row whose
 * words say "Reconciled" still says so in the database; it simply also records
 * that the state was `reconciled`, and the reader words that as "Closed".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT IS RUN — deliberately, by a maintainer, never by a deploy.
 *
 * Nothing here is on the public API, nothing is wired to a cron, and there is
 * no UI. It is dispatched through the `run-convex-function.yml` workflow (the
 * `reimbursementApprovedNoticeBackfill` precedent), which is
 * `workflow_dispatch`-only behind the `production` environment gate:
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=financeAuditKeyBackfill:backfillAuditKeys \
 *     -f args='{}'                      # DRY RUN — writes nothing
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=financeAuditKeyBackfill:backfillAuditKeys \
 *     -f args='{"execute":true}'        # the real patch
 *
 * On ACCESS: this is an `internalAction` reached only with the deployment's
 * admin key, so there is no `ctx.auth` identity to resolve and no seat
 * capability to check — a `require…` resolver (CLAUDE.md, "Gate It Behind a
 * Power") would have no caller to gate. The gate that actually exists is the
 * deploy key plus the workflow's maintainer-only dispatch and
 * production-environment approval. Should this ever grow an in-app trigger,
 * THAT call site is where a named resolver belongs.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * IDEMPOTENT, and cheaply so. A row is a candidate only while the key it needs
 * is ABSENT (`skipped` counts the ones already done, including every row the
 * live writers have stamped since). Re-running claims nothing new; a run that
 * dies mid-table and restarts from the beginning re-reads what it already
 * patched and skips all of it. The mapping is a pure function of the row's own
 * `action`/`field`/words, so a second pass over the same row computes the same
 * key or none at all — there is no ordering, no clock, and nothing to
 * double-apply.
 *
 * THE 1:1 CLAIM, CHECKED RATHER THAN ASSUMED. Mapping words back to a state is
 * only safe if no two states in one vocabulary have ever shared a word.
 * `@events-os/shared`'s `financeAuditValue.ts` builds its label→key lookup
 * through `assertUnambiguous`, which THROWS at module load if any label ever
 * meant two things — so an ambiguity would fail this sweep (and the whole
 * deployment's tests) before it could guess. The reverse — two labels meaning
 * ONE state — is fine and is exactly what a rename looks like: "Reconciled" and
 * "Closed" both map to `reconciled`. Across the nine keyed vocabularies today
 * there is no collision, and the historical label list carries exactly one
 * retired word (#717's "Reconciled").
 *
 * UNMAPPABLE ROWS ARE LEFT ALONE, ON PURPOSE. `unmapped` counts sides whose
 * words no vocabulary has ever shown — a wording a writer has since changed, or
 * an action that was free text when the row was written. Those rows keep
 * rendering their frozen string, which is the honest outcome: the alternative
 * is keying a row to a state nobody can prove it recorded, and a fabricated
 * audit key is worse than an old-fashioned one. A dry run reports the count so
 * a maintainer can look at them before deciding they don't matter.
 *
 * BOUNDED. `financeAuditLog` has no index for "missing a key" (the fields are
 * sparse by design), so the sweep pages the table with `.paginate()` at
 * `PAGE_SIZE` rows per invocation and maps in JS — the same shape
 * `reimbursementApprovedNoticeBackfill.ts` uses. Each invocation reads a fixed,
 * small number of documents and writes at most `PAGE_SIZE` patches, well inside
 * a Convex transaction's limits, and self-reschedules with the continue cursor
 * until the table is drained. A running `progress` tally rides along the
 * reschedules so the final log line reports the whole run rather than its last
 * page.
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  financeAuditKeyFromLabel,
  financeAuditValueKind,
} from "@events-os/shared";

/** Rows read (and at most patched) per invocation. */
const PAGE_SIZE = 200;

/** The running tally carried across self-reschedules. */
interface Progress {
  scanned: number;
  keyed: number;
  skipped: number;
  freeText: number;
  unmapped: number;
}

const progressValidator = v.object({
  /** Audit rows read. */
  scanned: v.number(),
  /** Rows this run gave at least one key to (or would, on a dry run). */
  keyed: v.number(),
  /** Keyed-vocabulary rows that already carried every key they need. */
  skipped: v.number(),
  /** Rows whose action has no closed vocabulary — nothing to key, by design. */
  freeText: v.number(),
  /** SIDES whose frozen words no vocabulary has ever shown. Left as they are. */
  unmapped: v.number(),
});

interface SweepPage extends Progress {
  isDone: boolean;
  continueCursor: string | null;
}

/**
 * Read one page, work out each row's keys, and — when `execute` — patch them
 * in. The mapping and the write live in the same mutation deliberately: the
 * decision is a pure function of the row, so splitting it across a query and a
 * mutation would only open a window for the row to change underneath the
 * answer.
 */
export const keyAuditPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    execute: v.boolean(),
  },
  handler: async (ctx, { cursor, numItems, execute }): Promise<SweepPage> => {
    const page = await ctx.db
      .query("financeAuditLog")
      .paginate({ numItems, cursor });

    let keyed = 0;
    let skipped = 0;
    let freeText = 0;
    let unmapped = 0;

    for (const row of page.page) {
      const kind = financeAuditValueKind(row.action, row.field);
      if (!kind) {
        freeText += 1;
        continue;
      }
      // A side needs work only when it HAS words and LACKS a key. A null side
      // (`unmarkPayout`'s `after`) is complete as it stands.
      const wantsBefore = row.before != null && row.beforeKey == null;
      const wantsAfter = row.after != null && row.afterKey == null;
      if (!wantsBefore && !wantsAfter) {
        skipped += 1;
        continue;
      }
      const beforeKey = wantsBefore
        ? financeAuditKeyFromLabel(kind, row.before)
        : null;
      const afterKey = wantsAfter
        ? financeAuditKeyFromLabel(kind, row.after)
        : null;
      if (wantsBefore && beforeKey == null) unmapped += 1;
      if (wantsAfter && afterKey == null) unmapped += 1;
      if (beforeKey == null && afterKey == null) continue;

      keyed += 1;
      if (execute) {
        await ctx.db.patch(row._id, {
          ...(beforeKey != null ? { beforeKey } : {}),
          ...(afterKey != null ? { afterKey } : {}),
        });
      }
    }

    return {
      scanned: page.page.length,
      keyed,
      skipped,
      freeText,
      unmapped,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Sweep the table and key every legacy row. DRY RUN BY DEFAULT: with `execute`
 * omitted or false it patches nothing and returns exactly the counts a real run
 * would produce.
 *
 * Both modes drain the whole table via self-reschedule, so a dry run's final
 * log line is a true backlog count rather than one page of it. The value
 * returned to `npx convex run` is the FIRST page plus its tally; the run's total
 * is the `[audit-key-backfill]` log line where `done` is true.
 */
export const backfillAuditKeys = internalAction({
  args: {
    execute: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    progress: v.optional(progressValidator),
  },
  handler: async (ctx, args): Promise<SweepPage> => {
    const execute = args.execute ?? false;
    const page: SweepPage = await ctx.runMutation(
      internal.financeAuditKeyBackfill.keyAuditPage,
      { cursor: args.cursor ?? null, numItems: PAGE_SIZE, execute },
    );

    const total: Progress = {
      scanned: (args.progress?.scanned ?? 0) + page.scanned,
      keyed: (args.progress?.keyed ?? 0) + page.keyed,
      skipped: (args.progress?.skipped ?? 0) + page.skipped,
      freeText: (args.progress?.freeText ?? 0) + page.freeText,
      unmapped: (args.progress?.unmapped ?? 0) + page.unmapped,
    };

    console.log(
      `[audit-key-backfill] ${execute ? "EXECUTE" : "DRY RUN"} scanned=${total.scanned} keyed=${total.keyed} skipped=${total.skipped} freeText=${total.freeText} unmapped=${total.unmapped} done=${page.isDone}`,
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.financeAuditKeyBackfill.backfillAuditKeys,
        { execute, cursor: page.continueCursor, progress: total },
      );
    }

    return {
      ...total,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
