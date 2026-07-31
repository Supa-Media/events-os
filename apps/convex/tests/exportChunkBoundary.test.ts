/**
 * REGRESSION — chunk-flush corruption at invocation boundaries.
 *
 * A large export cannot finish in one action invocation, so the runner
 * flushes its buffer to a storage chunk and reschedules itself; the chunks
 * are later concatenated as RAW BYTES into the final file. The row separator
 * used to be prepended only when the in-memory `buffer` was already non-empty
 * — which is false at the start of every resumed invocation. So the last row
 * of one chunk fused onto the first row of the next, producing a single
 * malformed line, while the job still reported the full `rowCount` and
 * `truncated: false`.
 *
 * That is the precise failure this feature exists to prevent: a file that
 * looks complete and is not. No unit test on the builders or the serializer
 * could see it — it only appears once a real walk spans more than one
 * invocation. Found by adversarial review; at 1041 rows two people vanished
 * into one 4-field row.
 *
 * This test seeds past `MAX_PAGES_PER_INVOCATION * pageSize` (40 * 25 = 1000
 * for the `people` builder) so the walk MUST span invocations, then parses
 * the finished CSV and asserts every row is well-formed and every seeded
 * person appears exactly once. Keep it seeded above 1000 — drop the count
 * below that and it silently stops testing anything.
 */
import { describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

// Minimal RFC4180 parser (naive split(",") is explicitly the wrong tool per
// the task brief) — handles quoted fields, embedded commas/CRLF/"" escapes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 2;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // trailing field/row (file should end with CRLF per buildCsvFile-style
  // trailing glue, but be defensive)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function stripBom(s: string): string {
  return s.startsWith("﻿") ? s.slice(1) : s;
}

async function seatSetup() {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return { t, chapter: await setupChapter(t) };
}

describe("PROBE — chunk-flush corruption at invocation boundaries", () => {
  test("assembled CSV rows are intact across a forced multi-chunk people export", async () => {
    vi.useFakeTimers();
    try {
      const { t, chapter: s } = await seatSetup();

      // Grant chapter_director so the caller has export reach.
      const personId = await run(t, (ctx) =>
        ctx.db.insert("people", {
          chapterId: s.chapterId,
          name: "Caller",
          userId: s.userId,
          createdAt: Date.now(),
        }),
      );
      const def = await run(t, (ctx) =>
        ctx.db
          .query("seatDefs")
          .withIndex("by_slug", (q) => q.eq("slug", "chapter_director"))
          .unique(),
      );
      if (!def) throw new Error("chapter_director not seeded");
      await run(t, (ctx) =>
        ctx.db.insert("seatAssignments", {
          seatDefId: def._id,
          scope: s.chapterId,
          personId,
          createdAt: Date.now(),
        }),
      );

      // Seed enough people to force >1 invocation of runExportJob: the people
      // builder's pageSize is 25 and MAX_PAGES_PER_INVOCATION is 40, so one
      // invocation caps out at 1000 rows. 1040 guarantees a second
      // invocation is required to finish the dataset, regardless of
      // EXPORT_CHUNK_CHARS.
      const TOTAL = 1040;
      const names: string[] = [];
      for (let i = 0; i < TOTAL; i++) {
        names.push(`Person Number ${String(i).padStart(4, "0")}`);
      }
      await run(t, async (ctx) => {
        for (const name of names) {
          await ctx.db.insert("people", {
            chapterId: s.chapterId,
            name,
            createdAt: Date.now(),
          });
        }
      });

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
      const file = job.files[0]!;
      expect(file.url).toEqual(expect.any(String));

      // Pull the raw bytes straight from storage (bypass the signed URL —
      // this is a probe, not an HTTP client) via the same convex-test
      // storage-get cast the existing suite uses.
      const jobRow = await run(t, (ctx) => ctx.db.get(jobId));
      const storageId = jobRow!.files[0]!.storageId!;
      const rawText = await run(t, async (ctx) => {
        const blob = await (
          ctx.storage as unknown as {
            get: (id: typeof storageId) => Promise<Blob | null>;
          }
        ).get(storageId);
        if (!blob) return null;
        return await blob.text();
      });
      expect(rawText).not.toBeNull();
      const text = stripBom(rawText!);

      // eslint-disable-next-line no-console
      console.log("RAW FILE (first 500 chars):\n" + text.slice(0, 500));
      // eslint-disable-next-line no-console
      console.log("RAW FILE LENGTH:", text.length);

      const rows = parseCsv(text.trimEnd());
      const header = rows[0]!;
      const dataRows = rows.slice(1);

      const expectedTotal = names.length + 1; // + the caller's own person row

      // eslint-disable-next-line no-console
      console.log("HEADER FIELD COUNT:", header.length);
      // eslint-disable-next-line no-console
      console.log("DATA ROW COUNT:", dataRows.length, "EXPECTED:", expectedTotal);
      let misaligned = 0;
      for (const r of dataRows) {
        if (r.length !== header.length) {
          misaligned++;
          if (misaligned <= 5) {
            // eslint-disable-next-line no-console
            console.log("MISALIGNED ROW:", JSON.stringify(r));
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log("MISALIGNED ROW COUNT:", misaligned);

      const nameIdx = header.indexOf("Name");
      const seenNames = dataRows.map((r) => r[nameIdx]);
      const expectedNames = [...names, "Caller"].sort();
      const actualSorted = [...seenNames].sort();
      const missing = expectedNames.filter((n) => !actualSorted.includes(n));
      const unexpected = actualSorted.filter((n) => !expectedNames.includes(n));
      // eslint-disable-next-line no-console
      console.log("MISSING NAMES (first 10):", JSON.stringify(missing.slice(0, 10)));
      // eslint-disable-next-line no-console
      console.log("UNEXPECTED/GARBLED NAMES (first 10):", JSON.stringify(unexpected.slice(0, 10)));
      // eslint-disable-next-line no-console
      console.log("job.files[0].truncated:", file.truncated, "job.files[0].rowCount:", file.rowCount);

      // Assertion: every seeded row appears EXACTLY once, and every row has
      // the right field count. This is expected to FAIL if the chunk-flush
      // hypothesis is correct.
      expect(dataRows.every((r) => r.length === header.length)).toBe(true);
      expect(actualSorted).toEqual(expectedNames);
      expect(file.rowCount).toBe(expectedTotal);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);
});
