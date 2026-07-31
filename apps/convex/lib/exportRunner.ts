/**
 * The data-export engine — the paginated walk from "job row" to "finished
 * CSV/NDJSON file in storage".
 *
 * ── Why an action drives this, and queries only ever answer ONE question ────
 * `ctx.storage.store` (writing a chunk blob) only exists on an action's ctx
 * (see `_generated/ai/guidelines.md`'s Action guidelines), so the walk has to
 * live in `runExportJob`, an `internalAction`. But an action has no `ctx.db`,
 * so every read of a builder's page (which needs `QueryCtx` to run its
 * indexed `.paginate()`) is delegated to `builderColumns`/`builderPage`,
 * internal QUERIES that do exactly the one `.paginate()` the builder contract
 * requires (`lib/exportBuilders/types.ts`'s module doc) and nothing else. Job
 * bookkeeping (progress, files, status) goes through internal MUTATIONS for
 * the same reason `ctx.db` can only be written inside a transaction.
 *
 * ── Why the action re-schedules itself instead of looping to completion ────
 * A single invocation processes at most `MAX_PAGES_PER_INVOCATION` pages of
 * ONE dataset, then either flushes what it has and reschedules
 * (`ctx.scheduler.runAfter(0, ...)`) or, if the dataset finished, assembles
 * the file and moves on to the next one. This bounds one invocation's memory
 * and runtime regardless of how large the export is, mirroring the house
 * "process a bounded batch, reschedule the rest" pattern
 * (`migrations/0042_wrap_targeting.ts`) — adapted for an action, which has no
 * transaction-size limit to enforce the bound for it.
 *
 * The in-memory CSV/NDJSON buffer is FLUSHED TO A STORAGE CHUNK (never merely
 * "when it gets big") at the end of every invocation that doesn't finish the
 * dataset outright. Since a fresh action invocation starts with empty JS
 * memory, any buffered-but-unflushed text would simply be lost the moment the
 * action reschedules itself — so the size threshold (`EXPORT_CHUNK_CHARS`) is
 * a trigger to stop accumulating and persist, not a rule that's ever allowed
 * to leave bytes stranded in memory across an invocation boundary.
 *
 * ── Reach travels as an argument, not a re-derived lookup ───────────────────
 * `ExportBuilderContext.reach` (giving/finance) is resolved ONCE, with the
 * real caller's identity, inside `dataExports.ts#requestExport` — the runner
 * has no caller identity at all (it's a scheduled system action), so it could
 * never re-derive `resolveExportDataReach` itself. `reach` is threaded
 * through every recursive `runExportJob` call instead of being stored on the
 * job document (whose schema this feature doesn't own the right to extend
 * here), which also keeps a mid-flight seat change from silently narrowing or
 * widening a job that's already running.
 *
 * ── Formats: CSV vs. NDJSON ──────────────────────────────────────────────────
 * `format: "csv"` writes RFC4180 CSV via `@events-os/shared/csv`, BOM-prefixed
 * exactly like `buildCsvFile`. `format: "json"` writes NEWLINE-DELIMITED JSON
 * (one row object per line) rather than a single JSON array — a JSON array
 * would need a comma inserted between every row EXCEPT the very last one
 * written, which is exactly the kind of cross-invocation state this file is
 * built to avoid holding. NDJSON needs none: every line is independent, so
 * chunks concatenate correctly no matter where a flush lands.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  CSV_BOM,
  csvHeaderLine,
  rowsToCsvBody,
  EXPORT_CHUNK_CHARS,
  EXPORT_JOB_STATUSES,
  EXPORT_MAX_ROWS,
  EXPORT_PAGE_SIZE,
  EXPORT_TTL_MS,
  EXPORT_FORMATS,
  exportFileName,
  isExportDatasetId,
  type CsvColumn,
  type ExportDatasetId,
  type ExportFilters,
  type ExportFormat,
  type ExportSectionId,
} from "@events-os/shared";
import { getExportBuilder } from "./exportBuilders/index";
import type { ExportBuilderContext } from "./exportBuilders/types";

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Hard cap on pages walked in one action invocation, independent of the
 *  chunk-size flush trigger — protects against a builder whose rows are so
 *  narrow that `EXPORT_CHUNK_CHARS` is never reached even after thousands of
 *  pages. Comfortably inside any Convex action's execution budget. */
const MAX_PAGES_PER_INVOCATION = 40;

/** A `running` job whose progress hasn't moved in this long is presumed dead
 *  (the action process crashed rather than throwing — see the module doc on
 *  `sweepExpiredExports`) and is failed by the sweep rather than left wedged
 *  forever with no signal. */
const STUCK_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Bound on rows scanned per sweep invocation — same posture as every other
 *  cron in `crons.ts`: a bounded batch per run, safe to run again next time. */
const SWEEP_SCAN_LIMIT = 200;

const filtersValidator = v.object({
  from: v.optional(v.number()),
  to: v.optional(v.number()),
  activeOnly: v.optional(v.boolean()),
  persona: v.optional(v.string()),
  rosterOnly: v.optional(v.boolean()),
});

const reachValidator = v.object({
  giving: v.boolean(),
  finance: v.boolean(),
});

const jobStatusValidator = v.union(
  ...EXPORT_JOB_STATUSES.map((s) => v.literal(s)),
);
const jobFormatValidator = v.union(...EXPORT_FORMATS.map((f) => v.literal(f)));

const cellValidator = v.union(v.string(), v.number(), v.boolean(), v.null());

// ── Internal reads used by the action ───────────────────────────────────────

/** The slice of a job the runner needs to drive one invocation. Deliberately
 *  narrower than the full row (see `dataExports.ts` for the public shape) —
 *  this is an internal contract the two files are free to evolve separately. */
const runStateValidator = v.union(
  v.null(),
  v.object({
    status: jobStatusValidator,
    scope: v.union(v.id("chapters"), v.literal("central")),
    scopeLabel: v.string(),
    datasetIds: v.array(v.string()),
    sectionIds: v.array(v.string()),
    omittedSectionIds: v.array(v.string()),
    filters: filtersValidator,
    format: jobFormatValidator,
    progress: v.optional(
      v.object({
        datasetIndex: v.number(),
        cursor: v.optional(v.string()),
        rowsWritten: v.number(),
        chunkStorageIds: v.array(v.id("_storage")),
      }),
    ),
  }),
);

export const getRunState = internalQuery({
  args: { jobId: v.id("exportJobs") },
  returns: runStateValidator,
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    return {
      status: job.status,
      scope: job.scope,
      scopeLabel: job.scopeLabel,
      datasetIds: job.datasetIds,
      sectionIds: job.sectionIds,
      omittedSectionIds: job.omittedSectionIds,
      filters: job.filters,
      format: job.format,
      progress: job.progress,
    };
  },
});

function buildBctx(args: {
  scope: Id<"chapters"> | "central";
  filters: ExportFilters;
  sectionIds: string[];
  reach: { giving: boolean; finance: boolean };
}): ExportBuilderContext {
  return {
    scope: args.scope,
    chapterId: args.scope === "central" ? null : args.scope,
    filters: args.filters,
    sections: new Set(args.sectionIds) as ReadonlySet<ExportSectionId>,
    reach: args.reach,
  };
}

export const builderColumns = internalQuery({
  args: {
    datasetId: v.string(),
    scope: v.union(v.id("chapters"), v.literal("central")),
    filters: filtersValidator,
    sectionIds: v.array(v.string()),
    reach: reachValidator,
  },
  returns: v.array(v.object({ key: v.string(), label: v.string() })),
  handler: async (ctx, args) => {
    const builder = getExportBuilder(args.datasetId);
    if (!builder) return [];
    const bctx = buildBctx(args);
    return await builder.columns(ctx, bctx);
  },
});

export const builderPage = internalQuery({
  args: {
    datasetId: v.string(),
    scope: v.union(v.id("chapters"), v.literal("central")),
    filters: filtersValidator,
    sectionIds: v.array(v.string()),
    reach: reachValidator,
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.object({
    rows: v.array(v.record(v.string(), cellValidator)),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const builder = getExportBuilder(args.datasetId);
    if (!builder) return { rows: [], cursor: null, isDone: true };
    const bctx = buildBctx(args);
    const page = await builder.page(ctx, bctx, args.cursor, args.numItems);
    // Convex values can't carry `undefined` (see the guidelines) — a builder
    // author following `ExportPage`'s `CsvValue` type may still omit a key or
    // set it `undefined` for "no value"; normalize to `null` (identical
    // downstream behavior — `csvField`/NDJSON both treat null as blank).
    const rows = page.rows.map((row) => {
      const clean: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(row)) {
        clean[key] = value === undefined ? null : value;
      }
      return clean;
    });
    return { rows, cursor: page.cursor, isDone: page.isDone };
  },
});

// ── Internal writes used by the action ──────────────────────────────────────

export const markRunning = internalMutation({
  args: { jobId: v.id("exportJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "queued") return null; // already running/terminal
    await ctx.db.patch(jobId, { status: "running", startedAt: Date.now() });
    return null;
  },
});

export const persistProgress = internalMutation({
  args: {
    jobId: v.id("exportJobs"),
    datasetIndex: v.number(),
    cursor: v.union(v.string(), v.null()),
    rowsWritten: v.number(),
    chunkStorageIds: v.array(v.id("_storage")),
  },
  returns: v.null(),
  handler: async (ctx, { jobId, datasetIndex, cursor, rowsWritten, chunkStorageIds }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "running") return null; // raced with fail/expire
    await ctx.db.patch(jobId, {
      progress: {
        datasetIndex,
        cursor: cursor ?? undefined,
        rowsWritten,
        chunkStorageIds,
      },
    });
    return null;
  },
});

const finishedFileValidator = v.object({
  datasetId: v.string(),
  fileName: v.string(),
  storageId: v.optional(v.id("_storage")),
  rowCount: v.number(),
  byteSize: v.number(),
  truncated: v.boolean(),
});

export const recordFinishedDataset = internalMutation({
  args: {
    jobId: v.id("exportJobs"),
    datasetIndex: v.number(),
    file: finishedFileValidator,
  },
  returns: v.null(),
  handler: async (ctx, { jobId, datasetIndex, file }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "running") return null; // raced with fail/expire
    const files = [...job.files];
    files[datasetIndex] = file;
    await ctx.db.patch(jobId, {
      files,
      totalRows: job.totalRows + file.rowCount,
      progress: {
        datasetIndex: datasetIndex + 1,
        cursor: undefined,
        rowsWritten: 0,
        chunkStorageIds: [],
      },
    });
    return null;
  },
});

export const finalizeJob = internalMutation({
  args: { jobId: v.id("exportJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "running") return null;
    const now = Date.now();
    await ctx.db.patch(jobId, {
      status: "ready",
      completedAt: now,
      expiresAt: now + EXPORT_TTL_MS,
      progress: undefined,
    });
    return null;
  },
});

export const failJob = internalMutation({
  args: { jobId: v.id("exportJobs"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { jobId, error }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status === "ready" || job.status === "expired") return null;
    await ctx.db.patch(jobId, {
      status: "failed",
      error,
      completedAt: Date.now(),
    });
    return null;
  },
});

// ── The action ───────────────────────────────────────────────────────────────

/**
 * Cap a freshly-read page so a dataset's cumulative row count never exceeds
 * `max` (`EXPORT_MAX_ROWS` by default) — the truncation rule from the spec:
 * a job that hits it finishes `ready` with `truncated: true` on that file,
 * and every surface showing it MUST say so. Pure and exported so it's unit
 * testable without a live builder (`tests/dataExports.test.ts`).
 */
export function capRowsAtMax<T>(
  rowsWritten: number,
  rows: T[],
  max: number = EXPORT_MAX_ROWS,
): { rows: T[]; truncated: boolean } {
  if (rowsWritten + rows.length < max) return { rows, truncated: false };
  return { rows: rows.slice(0, Math.max(0, max - rowsWritten)), truncated: true };
}

/** Serialize one page of rows against the fixed column list, in the job's
 *  chosen format. See the module doc for why JSON is NDJSON, not one array. */
function serializePage(
  format: ExportFormat,
  columns: CsvColumn[],
  rows: Record<string, string | number | boolean | null>[],
): string {
  if (format === "csv") return rowsToCsvBody(columns, rows);
  if (rows.length === 0) return "";
  return rows
    .map((row) => {
      const obj: Record<string, string | number | boolean | null> = {};
      for (const c of columns) obj[c.label] = row[c.key] ?? null;
      return JSON.stringify(obj);
    })
    .join("\n");
}

/** Human-readable failure text — never a raw stack (`schema/dataExports.ts`'s
 *  `error` field doc). */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const runExportJob = internalAction({
  args: { jobId: v.id("exportJobs"), reach: reachValidator },
  returns: v.null(),
  handler: async (ctx, { jobId, reach }) => {
    try {
      const job = await ctx.runQuery(internal.lib.exportRunner.getRunState, {
        jobId,
      });
      if (!job) return null; // deleted mid-flight — nothing to do
      if (job.status === "failed" || job.status === "ready" || job.status === "expired") {
        return null; // already terminal — a stale/duplicate schedule, ignore
      }
      if (job.status === "queued") {
        await ctx.runMutation(internal.lib.exportRunner.markRunning, { jobId });
      }

      const datasetIndex = job.progress?.datasetIndex ?? 0;
      if (datasetIndex >= job.datasetIds.length) {
        await ctx.runMutation(internal.lib.exportRunner.finalizeJob, { jobId });
        return null;
      }

      const rawDatasetId = job.datasetIds[datasetIndex];
      const knownDatasetId = isExportDatasetId(rawDatasetId) ? rawDatasetId : null;
      const builder = knownDatasetId ? getExportBuilder(knownDatasetId) : null;

      if (!builder || !knownDatasetId) {
        // Retired/unknown dataset id on an old job — degrade to a
        // zero-row, un-downloadable file entry rather than crashing the
        // whole job (`lib/exportBuilders/index.ts`'s doc on `getExportBuilder`
        // returning null). `url` reads `null` downstream since there's no
        // `storageId`.
        const fileName = safeFileName(rawDatasetId, job.scopeLabel, job.format);
        await ctx.runMutation(internal.lib.exportRunner.recordFinishedDataset, {
          jobId,
          datasetIndex,
          file: {
            datasetId: rawDatasetId,
            fileName,
            storageId: undefined,
            rowCount: 0,
            byteSize: 0,
            truncated: false,
          },
        });
        await ctx.scheduler.runAfter(0, internal.lib.exportRunner.runExportJob, {
          jobId,
          reach,
        });
        return null;
      }

      const datasetId: ExportDatasetId = knownDatasetId;
      // A builder may declare a smaller per-page read count than the default
      // (`ExportBuilder.pageSize`, `lib/exportBuilders/types.ts`'s doc) when
      // its per-row enrichment joins make the default too read-heavy for one
      // transaction. Honor it here — the runner never assumes the default fits
      // every builder.
      const numItems = builder.pageSize ?? EXPORT_PAGE_SIZE;
      const allowedSectionIds = job.sectionIds.filter(
        (id) => !job.omittedSectionIds.includes(id),
      );

      const columns = await ctx.runQuery(internal.lib.exportRunner.builderColumns, {
        datasetId,
        scope: job.scope,
        filters: job.filters,
        sectionIds: allowedSectionIds,
        reach,
      });

      const progress = job.progress ?? {
        datasetIndex,
        cursor: undefined,
        rowsWritten: 0,
        chunkStorageIds: [] as Id<"_storage">[],
      };
      const freshStart =
        progress.cursor === undefined &&
        progress.rowsWritten === 0 &&
        progress.chunkStorageIds.length === 0;

      let buffer =
        freshStart && job.format === "csv"
          ? CSV_BOM + csvHeaderLine(columns)
          : "";
      let cursor: string | null = progress.cursor ?? null;
      let rowsWritten = progress.rowsWritten;
      const chunkStorageIds: Id<"_storage">[] = [...progress.chunkStorageIds];
      let truncated = false;
      let datasetDone = false;
      const glue = job.format === "csv" ? "\r\n" : "\n";

      for (let page = 0; page < MAX_PAGES_PER_INVOCATION; page++) {
        const result = await ctx.runQuery(internal.lib.exportRunner.builderPage, {
          datasetId,
          scope: job.scope,
          filters: job.filters,
          sectionIds: allowedSectionIds,
          reach,
          cursor,
          numItems,
        });

        const capped = capRowsAtMax(rowsWritten, result.rows);
        const rows = capped.rows;
        if (capped.truncated) truncated = true;

        const body = serializePage(job.format, columns, rows);
        if (body.length > 0) buffer += (buffer.length > 0 ? glue : "") + body;
        rowsWritten += rows.length;
        cursor = result.cursor;
        datasetDone = truncated || result.isDone;

        if (datasetDone || buffer.length > EXPORT_CHUNK_CHARS) break;
      }

      if (datasetDone && buffer.length > 0) buffer += glue;

      if (buffer.length > 0) {
        const blob = new Blob([buffer], {
          type: job.format === "csv" ? "text/csv" : "application/x-ndjson",
        });
        chunkStorageIds.push(await ctx.storage.store(blob));
      }

      if (!datasetDone) {
        await ctx.runMutation(internal.lib.exportRunner.persistProgress, {
          jobId,
          datasetIndex,
          cursor,
          rowsWritten,
          chunkStorageIds,
        });
        await ctx.scheduler.runAfter(0, internal.lib.exportRunner.runExportJob, {
          jobId,
          reach,
        });
        return null;
      }

      // Dataset finished — assemble every chunk into ONE final blob, then
      // delete the chunks. Fetched/stored here (in the action) because only
      // an action can `ctx.storage.store`; `ctx.storage.get`/`.delete` work
      // here too, so there's no need to round-trip through a mutation for
      // either.
      const parts: Blob[] = [];
      for (const id of chunkStorageIds) {
        const blob = await ctx.storage.get(id);
        if (blob) parts.push(blob);
      }
      const finalBlob = new Blob(parts, {
        type: job.format === "csv" ? "text/csv" : "application/x-ndjson",
      });
      const finalStorageId = await ctx.storage.store(finalBlob);
      for (const id of chunkStorageIds) await ctx.storage.delete(id);

      const fileName = exportFileName({
        datasetId,
        scopeLabel: job.scopeLabel,
        at: Date.now(),
        format: job.format,
      });

      await ctx.runMutation(internal.lib.exportRunner.recordFinishedDataset, {
        jobId,
        datasetIndex,
        file: {
          datasetId,
          fileName,
          storageId: finalStorageId,
          rowCount: rowsWritten,
          byteSize: finalBlob.size,
          truncated,
        },
      });

      if (datasetIndex + 1 < job.datasetIds.length) {
        await ctx.scheduler.runAfter(0, internal.lib.exportRunner.runExportJob, {
          jobId,
          reach,
        });
      } else {
        await ctx.runMutation(internal.lib.exportRunner.finalizeJob, { jobId });
      }
      return null;
    } catch (err) {
      // Failure is reported, never silent (spec item 5) — any throw anywhere
      // above lands here rather than leaving the job stuck `running` with no
      // signal. A crashed/killed action process (no throw reaches this catch
      // at all) is instead caught by `sweepExpiredExports`'s stuck-job check.
      await ctx.runMutation(internal.lib.exportRunner.failJob, {
        jobId,
        error: describeError(err),
      });
      return null;
    }
  },
});

/** Best-effort filename for a dataset id that no longer resolves through
 *  `EXPORT_DATASETS` (retired since the job was created) — `exportFileName`
 *  itself requires a known id, so this is the degrade path. */
function safeFileName(datasetId: string, scopeLabel: string, format: ExportFormat): string {
  const stem = datasetId.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "export";
  const scope = scopeLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const day = new Date().toISOString().slice(0, 10);
  return [stem, scope, day].filter((p) => p.length > 0).join("-") + `.${format}`;
}

// ── Expiry + stuck-job sweep (cron) ─────────────────────────────────────────

/**
 * Purge storage for `ready` jobs past `expiresAt`, and fail `running` jobs
 * that have gone quiet for longer than `STUCK_JOB_TIMEOUT_MS` (the action
 * process died without throwing — see the module doc). NEVER deletes a job
 * row (`schema/dataExports.ts`'s module doc: the row is the audit trail).
 * Bounded per run (`SWEEP_SCAN_LIMIT` each), safe to re-run — matches every
 * other cron in `crons.ts`.
 */
export const sweepExpiredExports = internalMutation({
  args: {},
  returns: v.object({ expired: v.number(), failedStuck: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let expired = 0;

    const readyJobs = await ctx.db
      .query("exportJobs")
      .withIndex("by_status_and_expires", (q) =>
        q.eq("status", "ready").lte("expiresAt", now),
      )
      .take(SWEEP_SCAN_LIMIT);

    for (const job of readyJobs) {
      for (const file of job.files) {
        if (file.storageId) await ctx.storage.delete(file.storageId);
      }
      const files = job.files.map((f) => ({ ...f, storageId: undefined }));
      await ctx.db.patch(job._id, { status: "expired", files });
      expired++;
    }

    let failedStuck = 0;
    const runningJobs = await ctx.db
      .query("exportJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(SWEEP_SCAN_LIMIT);

    for (const job of runningJobs) {
      const lastActivity = job.startedAt ?? job.createdAt;
      if (now - lastActivity < STUCK_JOB_TIMEOUT_MS) continue;
      await ctx.db.patch(job._id, {
        status: "failed",
        error:
          "Export timed out — the job stopped making progress. Please request a new export.",
        completedAt: now,
      });
      failedStuck++;
    }

    return { expired, failedStuck };
  },
});
