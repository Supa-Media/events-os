/**
 * Data Export — `dataExports.ts` (public API) + `lib/exportRunner.ts` (the
 * paginated runner) + `lib/exportBuilders/index.ts` (the completeness gate).
 *
 * This engine was built against the BUILDER INTERFACE
 * (`lib/exportBuilders/types.ts`), not any one builder's implementation — at
 * the time this file was written, every dataset in `lib/exportBuilders/*.ts`
 * was still an empty-array stub (a sibling workstream landed them
 * concurrently). The completeness test below is written to FAIL LOUDLY for
 * as long as that's true (see its own comment) rather than being weakened;
 * by the time this suite runs it may already report every builder present,
 * which is the intended end state, not a sign the test stopped doing its job.
 */
import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { EXPORT_MAX_ROWS } from "@events-os/shared";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import {
  unimplementedDatasetIds,
  orphanBuilderIds,
} from "../lib/exportBuilders/index";
import { capRowsAtMax } from "../lib/exportRunner";

// ── Setup helpers (mirrors tests/campaignPower.test.ts's shape) ────────────

async function seatSetup(opts: { email?: string } = {}) {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return { t, chapter: await setupChapter(t, opts) };
}

async function defBySlug(t: ReturnType<typeof newT>, slug: string): Promise<Doc<"seatDefs">> {
  const def = await run(t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

async function seedSelfPerson(
  t: ReturnType<typeof newT>,
  s: ChapterSetup,
  name = "Caller",
): Promise<Id<"people">> {
  return run(t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function grantSeat(
  t: ReturnType<typeof newT>,
  slug: string,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
): Promise<void> {
  const def = await defBySlug(t, slug);
  await run(t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

// ── Builder completeness (`lib/exportBuilders/index.ts`) ────────────────────

describe("export builder completeness", () => {
  test("every declared dataset has a registered builder, and no orphans exist", () => {
    // EXPECTED TO FAIL until the sibling builder workstream lands every
    // dataset (`lib/exportBuilders/index.ts`'s own doc: "this is what makes
    // 'the picker offers a dataset that produces an empty file' impossible to
    // ship"). Left in place, unweakened, on purpose — see this file's module
    // doc and the PR's own report.
    expect(unimplementedDatasetIds()).toEqual([]);
    expect(orphanBuilderIds()).toEqual([]);
  });
});

// ── requestExport — auth ─────────────────────────────────────────────────────

describe("requestExport — auth", () => {
  test("a caller without data.export is FORBIDDEN", async () => {
    const { t, chapter: s } = await seatSetup();
    await seedSelfPerson(t, s); // no seat at all — no export reach anywhere

    await expect(
      s.as.mutation(api.dataExports.requestExport, {
        scope: s.chapterId,
        datasetIds: ["people"],
        sectionIds: [],
        format: "csv",
        filters: {},
      }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });

  test("data.export without giving.view: gifts is FORBIDDEN; people succeeds with giving_summary omitted", async () => {
    const { t, chapter: s } = await seatSetup();
    // Marketing Director: data.export, deliberately NO giving.view
    // (`packages/shared/src/seats.ts`'s own comment on this exact scenario).
    const personId = await seedSelfPerson(t, s, "Marketing Director");
    await grantSeat(t, "marketing_director", "central", personId);

    await expect(
      s.as.mutation(api.dataExports.requestExport, {
        scope: s.chapterId,
        datasetIds: ["gifts"],
        sectionIds: [],
        format: "csv",
        filters: {},
      }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });

    const { jobId } = await s.as.mutation(api.dataExports.requestExport, {
      scope: s.chapterId,
      datasetIds: ["people"],
      sectionIds: ["giving_summary", "contact"],
      format: "csv",
      filters: {},
    });

    const job = await run(t, (ctx) => ctx.db.get(jobId));
    expect(job).not.toBeNull();
    expect(job!.omittedSectionIds).toContain("giving_summary");
    expect(job!.sectionIds).toEqual(
      expect.arrayContaining(["giving_summary", "contact"]),
    );
    // The dataset itself still went through — export never widens reach, but
    // it also never fails a dataset over a SECTION-level gap.
    expect(job!.datasetIds).toEqual(["people"]);
  });
});

// ── Job-scoped reads never leak across chapters ─────────────────────────────

describe("getExportJob — scope isolation", () => {
  test("a job for another chapter is not readable", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterA = await setupChapter(t, {
      email: "director-a@publicworship.life",
      chapterName: "Chapter A",
    });
    const chapterB = await setupChapter(t, {
      email: "director-b@publicworship.life",
      chapterName: "Chapter B",
    });

    const personA = await seedSelfPerson(t, chapterA, "Director A");
    await grantSeat(t, "chapter_director", chapterA.chapterId, personA);
    const personB = await seedSelfPerson(t, chapterB, "Director B");
    await grantSeat(t, "chapter_director", chapterB.chapterId, personB);

    const { jobId } = await chapterB.as.mutation(api.dataExports.requestExport, {
      scope: chapterB.chapterId,
      datasetIds: ["people"],
      sectionIds: [],
      format: "csv",
      filters: {},
    });

    // Chapter A's director holds export reach — just not at Chapter B's scope
    // — so this must fail on the SCOPE check, not merely "no export at all".
    await expect(
      chapterA.as.query(api.dataExports.getExportJob, { jobId }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });

    // The requester themself can always read their own job.
    const job = await chapterB.as.query(api.dataExports.getExportJob, { jobId });
    expect(job._id).toBe(jobId);
    expect(job.scope).toBe(chapterB.chapterId);
  });

  test("listExportJobs also requires export reach at the requested scope", async () => {
    const { t, chapter: s } = await seatSetup();
    await seedSelfPerson(t, s); // no seat

    await expect(
      s.as.query(api.dataExports.listExportJobs, { scope: s.chapterId }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});

// ── Truncation ────────────────────────────────────────────────────────────

describe("capRowsAtMax", () => {
  test("caps a page at the max and reports truncation", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ i }));
    const capped = capRowsAtMax(EXPORT_MAX_ROWS - 4, rows);
    expect(capped.truncated).toBe(true);
    expect(capped.rows).toHaveLength(4);
  });

  test("does not truncate comfortably under the cap", () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const capped = capRowsAtMax(0, rows);
    expect(capped.truncated).toBe(false);
    expect(capped.rows).toHaveLength(2);
  });

  test("a page landing exactly on the cap IS marked truncated (conservative: we stop reading either way, and can't tell without one more page whether more rows existed)", () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const capped = capRowsAtMax(EXPORT_MAX_ROWS - 2, rows);
    expect(capped.truncated).toBe(true);
    expect(capped.rows).toHaveLength(2);
  });
});

// ── End-to-end sanity (now that a real builder exists) ─────────────────────

describe("requestExport → runExportJob — end to end", () => {
  test("a people export runs to completion with a downloadable file", async () => {
    vi.useFakeTimers();
    try {
      const { t, chapter: s } = await seatSetup();
      const directorId = await seedSelfPerson(t, s, "Chapter Director");
      await grantSeat(t, "chapter_director", s.chapterId, directorId);
      // A second, ordinary roster row so the export has something to walk
      // beyond the caller's own person row.
      await run(t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Regular Member",
          createdAt: Date.now(),
        }),
      );

      const { jobId } = await s.as.mutation(api.dataExports.requestExport, {
        scope: s.chapterId,
        datasetIds: ["people"],
        sectionIds: [],
        format: "csv",
        filters: {},
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const job = await s.as.query(api.dataExports.getExportJob, { jobId });
      expect(job.status).toBe("ready");
      expect(job.files).toHaveLength(1);
      expect(job.files[0]!.datasetId).toBe("people");
      // The director + the regular member — both non-placeholder roster rows.
      expect(job.files[0]!.rowCount).toBe(2);
      expect(job.files[0]!.truncated).toBe(false);
      expect(job.files[0]!.url).toEqual(expect.any(String));
      expect(job.totalRows).toBe(2);
      expect(job.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Expiry sweep ──────────────────────────────────────────────────────────

describe("sweepExpiredExports", () => {
  test("clears file storageIds on an expired ready job and KEEPS the row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storeBlob(t);
    const past = Date.now() - 1000;

    const jobId = await run(t, (ctx) =>
      ctx.db.insert("exportJobs", {
        scope: s.chapterId,
        scopeLabel: "Test Chapter",
        requestedByUserId: s.userId,
        requestedByLabel: "Someone",
        datasetIds: ["people"],
        sectionIds: [],
        omittedSectionIds: [],
        format: "csv",
        filters: {},
        status: "ready",
        files: [
          {
            datasetId: "people",
            fileName: "people-test-chapter-2026-07-31.csv",
            storageId,
            rowCount: 1,
            byteSize: 10,
            truncated: false,
          },
        ],
        totalRows: 1,
        createdAt: past,
        startedAt: past,
        completedAt: past,
        expiresAt: past,
        downloadCount: 0,
      }),
    );

    const result = await t.mutation(internal.lib.exportRunner.sweepExpiredExports, {});
    expect(result.expired).toBe(1);

    const job = await run(t, (ctx) => ctx.db.get(jobId));
    expect(job).not.toBeNull(); // the row is the audit trail — never deleted
    expect(job!.status).toBe("expired");
    expect(job!.files).toHaveLength(1);
    expect(job!.files[0]!.storageId).toBeUndefined();
    // Other file fields survive the purge — only the blob pointer is cleared.
    expect(job!.files[0]!.rowCount).toBe(1);
    expect(job!.files[0]!.fileName).toBe("people-test-chapter-2026-07-31.csv");

    // `ctx.storage.get` is action-only on the generated types (see
    // `setup.helpers.ts`'s `storeBlob` doc for the same convex-test
    // affordance/cast on `.store`); it works here at runtime under
    // convex-test, so read it through the same kind of cast.
    const blob = await run(t, (ctx) =>
      (ctx.storage as unknown as {
        get: (id: Id<"_storage">) => Promise<Blob | null>;
      }).get(storageId),
    );
    expect(blob).toBeNull();
  });

  test("fails a running job that has gone quiet past the stuck-job timeout, and keeps the row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const longAgo = Date.now() - 3 * 60 * 60 * 1000; // 3h > the 2h timeout

    const jobId = await run(t, (ctx) =>
      ctx.db.insert("exportJobs", {
        scope: s.chapterId,
        scopeLabel: "Test Chapter",
        requestedByUserId: s.userId,
        requestedByLabel: "Someone",
        datasetIds: ["people"],
        sectionIds: [],
        omittedSectionIds: [],
        format: "csv",
        filters: {},
        status: "running",
        files: [],
        totalRows: 0,
        createdAt: longAgo,
        startedAt: longAgo,
        downloadCount: 0,
      }),
    );

    const result = await t.mutation(internal.lib.exportRunner.sweepExpiredExports, {});
    expect(result.failedStuck).toBe(1);

    const job = await run(t, (ctx) => ctx.db.get(jobId));
    expect(job).not.toBeNull();
    expect(job!.status).toBe("failed");
    expect(job!.error).toBeTruthy();
  });

  test("a recently-started running job is left alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();

    const jobId = await run(t, (ctx) =>
      ctx.db.insert("exportJobs", {
        scope: s.chapterId,
        scopeLabel: "Test Chapter",
        requestedByUserId: s.userId,
        requestedByLabel: "Someone",
        datasetIds: ["people"],
        sectionIds: [],
        omittedSectionIds: [],
        format: "csv",
        filters: {},
        status: "running",
        files: [],
        totalRows: 0,
        createdAt: now,
        startedAt: now,
        downloadCount: 0,
      }),
    );

    const result = await t.mutation(internal.lib.exportRunner.sweepExpiredExports, {});
    expect(result.failedStuck).toBe(0);

    const job = await run(t, (ctx) => ctx.db.get(jobId));
    expect(job!.status).toBe("running");
  });
});
