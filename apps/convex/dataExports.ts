/**
 * Data Export — the public API. See `packages/shared/src/dataExport.ts` for
 * the vocabulary this implements and `apps/convex/lib/dataExportAccess.ts`
 * for the gate every function here goes through.
 *
 * SURFACE IS FIXED (Agent WS4 builds the picker/download UI against it):
 *
 *   myExportAccess()                                  -> access + scope picker
 *   requestExport({scope, datasetIds, sectionIds,
 *                  format, filters})                  -> { jobId }
 *   listExportJobs({scope})                           -> Job[]  (newest first)
 *   getExportJob({jobId})                             -> Job & files[].url
 *   recordExportDownload({jobId})                     -> null
 *
 * ── Auth shape common to every read ──────────────────────────────────────────
 * A job id is NEVER treated as a bearer token. `requireJobAccess` re-checks
 * `requireExport` against the JOB'S OWN `scope` (so a since-revoked seat can't
 * keep reading an old job) AND requires the caller be either the original
 * requester or hold central export reach — otherwise a chapter-scoped export
 * job would be readable by guessing/enumerating ids, leaking another
 * chapter's densest concentration of personal data.
 *
 * The actual paginated walk lives in `lib/exportRunner.ts`; `requestExport`
 * only inserts the job row and schedules it.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  EXPORT_DATASETS,
  EXPORT_FORMATS,
  EXPORT_JOB_STATUSES,
  allowedSections,
  isExportDatasetId,
  isExportSectionId,
  type ExportDatasetId,
} from "@events-os/shared";
import {
  requireExport,
  requireExportDataset,
  resolveExportAccess,
  resolveExportDataReach,
  type ExportScope,
} from "./lib/dataExportAccess";
import { requireUserId } from "./lib/context";
import { listActiveChapters } from "./lib/chapters";

// ── Bounds ───────────────────────────────────────────────────────────────────

/** `myExportAccess`'s per-chapter reach lookup and the fleet listing it walks
 *  when the caller holds central reach — matches `listActiveChapters`'s own
 *  default and every other fleet enumerator in the repo. */
const CHAPTER_LIST_LIMIT = 200;

/** `listExportJobs` is a picker-backing list, not an archive browser — bounded
 *  the same way every other list query in this repo is (module doc of
 *  `packages/shared/src/dataExport.ts`, "why a registry rather than a query
 *  per screen"). */
const JOB_LIST_LIMIT = 50;

/** Bound on the caller's own `people` rows scanned for a display label —
 *  mirrors `viewerPerson`/`mySeats`'s walk of "every roster row this user
 *  owns", which is never more than a handful in practice. */
const REQUESTER_LOOKUP_LIMIT = 10;

// ── Shared validators ────────────────────────────────────────────────────────

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const formatValidator = v.union(...EXPORT_FORMATS.map((f) => v.literal(f)));
const statusValidator = v.union(...EXPORT_JOB_STATUSES.map((s) => v.literal(s)));

const filtersValidator = v.object({
  from: v.optional(v.number()),
  to: v.optional(v.number()),
  activeOnly: v.optional(v.boolean()),
  persona: v.optional(v.string()),
  rosterOnly: v.optional(v.boolean()),
});

const progressValidator = v.object({
  datasetIndex: v.number(),
  cursor: v.optional(v.string()),
  rowsWritten: v.number(),
  chunkStorageIds: v.array(v.id("_storage")),
});

const fileValidator = v.object({
  datasetId: v.string(),
  fileName: v.string(),
  storageId: v.optional(v.id("_storage")),
  rowCount: v.number(),
  byteSize: v.number(),
  truncated: v.boolean(),
});

/** The full job row, exactly mirroring `schema/dataExports.ts` (system fields
 *  included) — the shape `listExportJobs` returns as-is. */
const exportJobValidator = v.object({
  _id: v.id("exportJobs"),
  _creationTime: v.number(),
  scope: scopeValidator,
  scopeLabel: v.string(),
  requestedByUserId: v.id("users"),
  requestedByPersonId: v.optional(v.id("people")),
  requestedByLabel: v.string(),
  datasetIds: v.array(v.string()),
  sectionIds: v.array(v.string()),
  omittedSectionIds: v.array(v.string()),
  format: formatValidator,
  filters: filtersValidator,
  status: statusValidator,
  error: v.optional(v.string()),
  files: v.array(fileValidator),
  progress: v.optional(progressValidator),
  totalRows: v.number(),
  createdAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  downloadCount: v.number(),
  lastDownloadedAt: v.optional(v.number()),
});

/** Same shape as `exportJobValidator`, but each file carries a resolved
 *  download `url` — the one enrichment `getExportJob` adds over the raw row. */
const exportJobWithUrlsValidator = v.object({
  _id: v.id("exportJobs"),
  _creationTime: v.number(),
  scope: scopeValidator,
  scopeLabel: v.string(),
  requestedByUserId: v.id("users"),
  requestedByPersonId: v.optional(v.id("people")),
  requestedByLabel: v.string(),
  datasetIds: v.array(v.string()),
  sectionIds: v.array(v.string()),
  omittedSectionIds: v.array(v.string()),
  format: formatValidator,
  filters: filtersValidator,
  status: statusValidator,
  error: v.optional(v.string()),
  files: v.array(
    v.object({
      datasetId: v.string(),
      fileName: v.string(),
      storageId: v.optional(v.id("_storage")),
      rowCount: v.number(),
      byteSize: v.number(),
      truncated: v.boolean(),
      url: v.union(v.string(), v.null()),
    }),
  ),
  progress: v.optional(progressValidator),
  totalRows: v.number(),
  createdAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  downloadCount: v.number(),
  lastDownloadedAt: v.optional(v.number()),
});

// ── myExportAccess ───────────────────────────────────────────────────────────

export const myExportAccess = query({
  args: {},
  returns: v.object({
    canExport: v.boolean(),
    scopes: v.array(
      v.object({
        scope: scopeValidator,
        label: v.string(),
        giving: v.boolean(),
        finance: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const access = await resolveExportAccess(ctx);
    if (!access.canExportAnywhere) return { canExport: false, scopes: [] };

    const entries: { scope: ExportScope; label: string }[] = [];
    if (access.centralExport) {
      entries.push({ scope: "central", label: "Central" });
      const chapters = await listActiveChapters(ctx, CHAPTER_LIST_LIMIT);
      for (const chapter of chapters) {
        entries.push({ scope: chapter._id, label: chapter.name });
      }
    } else {
      for (const chapterId of access.exportChapters) {
        const chapter = await ctx.db.get(chapterId as Id<"chapters">);
        entries.push({
          scope: chapterId as Id<"chapters">,
          label: chapter?.name ?? "Chapter",
        });
      }
    }

    const scopes = await Promise.all(
      entries.map(async (entry) => {
        const reach = await resolveExportDataReach(ctx, entry.scope);
        return {
          scope: entry.scope,
          label: entry.label,
          giving: reach.giving,
          finance: reach.finance,
        };
      }),
    );

    return { canExport: true, scopes };
  },
});

// ── requestExport ────────────────────────────────────────────────────────────

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

async function resolveScopeLabel(
  ctx: MutationCtx,
  scope: ExportScope,
): Promise<string> {
  if (scope === "central") return "Central";
  const chapter = await ctx.db.get(scope);
  return chapter?.name ?? "Chapter";
}

/** Best-effort snapshot of who's asking, for the audit trail
 *  (`schema/dataExports.ts`'s `requestedByLabel` doc — resolved once, never
 *  live). Prefers the caller's roster row IN this scope's chapter, falling
 *  back to any of the caller's own (non-placeholder) roster rows, then to
 *  their account email. */
async function requesterLabel(
  ctx: MutationCtx,
  userId: Id<"users">,
  scope: ExportScope,
): Promise<{ personId: Id<"people"> | undefined; label: string }> {
  const rows = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(REQUESTER_LOOKUP_LIMIT);
  const real = rows.filter((p) => p.isPlaceholder !== true);
  const person =
    (scope !== "central" ? real.find((p) => p.chapterId === scope) : undefined) ??
    real[0];
  if (person) return { personId: person._id, label: person.name };
  const user = await ctx.db.get(userId);
  return { personId: undefined, label: user?.email ?? "Unknown" };
}

export const requestExport = mutation({
  args: {
    scope: scopeValidator,
    datasetIds: v.array(v.string()),
    sectionIds: v.array(v.string()),
    format: formatValidator,
    filters: filtersValidator,
  },
  returns: v.object({ jobId: v.id("exportJobs") }),
  handler: async (ctx, args) => {
    const scope = args.scope;

    const requestedDatasetIds = dedupe(args.datasetIds);
    if (requestedDatasetIds.length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Select at least one dataset to export.",
      });
    }
    for (const id of requestedDatasetIds) {
      if (!isExportDatasetId(id)) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Unknown dataset: ${id}`,
        });
      }
      if (scope === "central" && !EXPORT_DATASETS[id].supportsCentral) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `${EXPORT_DATASETS[id].label} can't be exported at the central level.`,
        });
      }
    }
    const datasetIds = requestedDatasetIds as ExportDatasetId[];
    const requestedSectionIds = dedupe(args.sectionIds).filter(isExportSectionId);

    // Export reach at the scope, THEN every requested dataset's own
    // pre-existing gate — export never widens reach (`lib/dataExportAccess.ts`'s
    // module doc). Any single dataset failing its gate fails the whole
    // request; a caller who can't see gifts doesn't get to ask for them.
    await requireExport(ctx, scope);
    for (const datasetId of datasetIds) {
      await requireExportDataset(ctx, scope, datasetId);
    }

    const reach = await resolveExportDataReach(ctx, scope);

    // Sections are narrower than datasets: a section the caller lacks reach
    // for is DROPPED, not a hard failure — recorded in `omittedSectionIds` so
    // the job (and the UI reading it) can say the file is narrower than what
    // was ticked. `allowedSections` is the SAME function the picker uses, so
    // the two can never disagree.
    const omittedSectionIds = new Set<string>();
    for (const datasetId of datasetIds) {
      const allowedIds = new Set(
        allowedSections(datasetId, reach).map((s) => s.id as string),
      );
      for (const section of EXPORT_DATASETS[datasetId].sections) {
        if (requestedSectionIds.includes(section.id) && !allowedIds.has(section.id)) {
          omittedSectionIds.add(section.id);
        }
      }
    }

    const userId = (await requireUserId(ctx)) as Id<"users">;
    const { personId, label } = await requesterLabel(ctx, userId, scope);
    const scopeLabel = await resolveScopeLabel(ctx, scope);

    const now = Date.now();
    const jobId = await ctx.db.insert("exportJobs", {
      scope,
      scopeLabel,
      requestedByUserId: userId,
      requestedByPersonId: personId,
      requestedByLabel: label,
      datasetIds,
      sectionIds: requestedSectionIds,
      omittedSectionIds: [...omittedSectionIds],
      format: args.format,
      filters: args.filters,
      status: "queued",
      files: [],
      totalRows: 0,
      createdAt: now,
      downloadCount: 0,
    });

    // Reach travels with every scheduled invocation rather than being stored
    // on the job — see `lib/exportRunner.ts`'s module doc for why the runner
    // (a caller-less scheduled action) can't re-derive it itself.
    await ctx.scheduler.runAfter(0, internal.lib.exportRunner.runExportJob, {
      jobId,
      reach,
    });

    return { jobId };
  },
});

// ── Reads: listExportJobs / getExportJob / recordExportDownload ────────────

/** A job id is never a bearer token — re-check export reach against the
 *  JOB'S OWN scope, and require the caller be either the requester or hold
 *  central reach. Shared by every read/write keyed on a specific job. */
async function requireJobAccess(
  ctx: QueryCtx,
  job: Doc<"exportJobs">,
): Promise<void> {
  const access = await requireExport(ctx, job.scope);
  if (access.isSuperuser || access.centralExport) return;
  const userId = await requireUserId(ctx);
  if (job.requestedByUserId === userId) return;
  throw new ConvexError({
    code: "FORBIDDEN",
    message: "You can only view exports you requested.",
  });
}

export const listExportJobs = query({
  args: { scope: scopeValidator },
  returns: v.array(exportJobValidator),
  handler: async (ctx, { scope }) => {
    await requireExport(ctx, scope);
    return await ctx.db
      .query("exportJobs")
      .withIndex("by_scope_and_created", (q) => q.eq("scope", scope))
      .order("desc")
      .take(JOB_LIST_LIMIT);
  },
});

export const getExportJob = query({
  args: { jobId: v.id("exportJobs") },
  returns: exportJobWithUrlsValidator,
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Export not found." });
    }
    await requireJobAccess(ctx, job);

    const files = await Promise.all(
      job.files.map(async (file) => ({
        ...file,
        url: file.storageId ? await ctx.storage.getUrl(file.storageId) : null,
      })),
    );

    return { ...job, files };
  },
});

export const recordExportDownload = mutation({
  args: { jobId: v.id("exportJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Export not found." });
    }
    await requireJobAccess(ctx, job);
    await ctx.db.patch(jobId, {
      downloadCount: job.downloadCount + 1,
      lastDownloadedAt: Date.now(),
    });
    return null;
  },
});
