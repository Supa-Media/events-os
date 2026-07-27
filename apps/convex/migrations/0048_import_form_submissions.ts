"use node";
/**
 * One-off Google Forms import (PW Forms consolidation, migration slot 0048 —
 * see `migrations/index.ts`'s module doc for the numbering scheme). Reads the
 * founder's 6 exported CSVs off local disk and commits them through
 * `formSubmissions.ts#importSubmissionsBatch`, batched so each mutation call
 * stays well within Convex's per-execution read/write budget. `"use node"`
 * (file-system access) means this MUST be a separate file from
 * `formSubmissions.ts`'s queries/mutations — see
 * `apps/convex/_generated/ai/guidelines.md`'s action guidelines.
 *
 * NOT WIRED INTO `migrations/index.ts`'s auto-registry — same reasoning as
 * the sibling `migrations/0037_link_rsvp_people.ts`: `runPending`'s
 * `Migration.run(ctx)` takes no arguments and executes unconditionally on the
 * first deploy that reaches it, with no human review in between. This import
 * needs a human to pass a real `chapterId` (and, for the one event-scoped
 * form, an `eventId`), eyeball a dry-run, and only THEN commit — the opposite
 * of "runs itself on deploy." It's still numbered for discoverability
 * alongside the rest of this folder, not because it's ledger-tracked.
 *
 * DRY-RUN FIRST, ALWAYS: `dryRun: true` (the default a human should always
 * try first) runs the exact same matching/parsing logic and returns the same
 * counts WITHOUT writing anything (see `importSubmissionsBatch`'s own doc for
 * how the preview/commit split works) — eyeball the counts, then re-run with
 * `dryRun: false`.
 *
 * IDEMPOTENT: safe to re-run (dry-run or execute) — `importSubmissionsBatch`
 * matches-or-creates people (never a duplicate person for the same identity)
 * and skips a submission that's already on file for that (form, person/event,
 * real Google-Forms timestamp) triple.
 *
 * EVENT-SCOPED FORMS: only the Eden: Worship & Picnic survey is event-scoped
 * in this catalog (`lib/formCatalog.ts`'s `scope: "event"`), and it's fully
 * ANONYMOUS (no name/email column at all) — there's no roster row to resolve
 * it against, only an `events` row to attach it to. Pass that event's id via
 * `eventIdByFormKey: { eden_survey: "<id>" }`; omitted, those rows still
 * import successfully (verbatim answers preserved), just with no `eventId`
 * set yet — re-running later with the id fills it in for any submissions not
 * already imported (a submission already committed keeps whatever `eventId`
 * it was written with; this import never edits an existing row).
 *
 * Run against the LOCAL dev backend (this repo's worktrees each run their
 * own local Convex backend — see `docs/architecture`'s worktree dev notes —
 * so `fs.readFileSync` below resolves against the machine actually running
 * `npx convex dev`, not a remote sandbox):
 *
 *   npx convex run migrations/0048_import_form_submissions:runImport \
 *     '{"chapterId": "<chapters id>", "dryRun": true}'
 *
 * then, once the dry-run counts look right:
 *
 *   npx convex run migrations/0048_import_form_submissions:runImport \
 *     '{"chapterId": "<chapters id>", "dryRun": false}'
 *
 * NEVER pass `--prod` for this — see the PR description for why (this has
 * only been run against a local/test backend, never staging or production).
 */
import fs from "node:fs";
import path from "node:path";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { FORM_CATALOG, parseFormCsv } from "../lib/formCatalog";

/** Where the founder's exports live on their machine — overridable via
 *  `csvDir` for testing against a fixtures folder. */
const DEFAULT_CSV_DIR = "/Users/lilseyi/Downloads/PW Forms";

/** Rows per `importSubmissionsBatch` call — keeps each batch's roster read +
 *  inserts + service-catalog lookups comfortably within one mutation's
 *  budget (mirrors `migrations/0037_link_rsvp_people.ts`'s batching spirit,
 *  just far smaller since this dataset tops out at ~110 rows per form). */
const BATCH_SIZE = 40;

type PerFormResult = {
  formKey: string;
  title: string;
  fileFound: boolean;
  rowsProcessed: number;
  submissionsWritten: number;
  peopleCreated: number;
  peopleMatched: number;
  skippedNoIdentifier: number;
  duplicatesSkipped: number;
  marketingOptOuts: number;
  servicesPromoted: number;
  unmappedServiceOptions: string[];
};

export const runImport = internalAction({
  args: {
    chapterId: v.id("chapters"),
    dryRun: v.boolean(),
    csvDir: v.optional(v.string()),
    eventIdByFormKey: v.optional(v.record(v.string(), v.id("events"))),
  },
  returns: v.object({
    dryRun: v.boolean(),
    csvDir: v.string(),
    perForm: v.array(
      v.object({
        formKey: v.string(),
        title: v.string(),
        fileFound: v.boolean(),
        rowsProcessed: v.number(),
        submissionsWritten: v.number(),
        peopleCreated: v.number(),
        peopleMatched: v.number(),
        skippedNoIdentifier: v.number(),
        duplicatesSkipped: v.number(),
        marketingOptOuts: v.number(),
        servicesPromoted: v.number(),
        unmappedServiceOptions: v.array(v.string()),
      }),
    ),
    totals: v.object({
      submissionsWritten: v.number(),
      peopleCreated: v.number(),
      peopleMatched: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    const dir = args.csvDir ?? DEFAULT_CSV_DIR;
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"))
      : [];

    const perForm: PerFormResult[] = [];

    for (const form of FORM_CATALOG) {
      const fileName = files.find((f) => f.includes(form.fileMatch));
      if (!fileName) {
        perForm.push({
          formKey: form.formKey,
          title: form.title,
          fileFound: false,
          rowsProcessed: 0,
          submissionsWritten: 0,
          peopleCreated: 0,
          peopleMatched: 0,
          skippedNoIdentifier: 0,
          duplicatesSkipped: 0,
          marketingOptOuts: 0,
          servicesPromoted: 0,
          unmappedServiceOptions: [],
        });
        continue;
      }

      const csvText = fs.readFileSync(path.join(dir, fileName), "utf8");
      const parsedRows = parseFormCsv(form, csvText);
      const eventId = args.eventIdByFormKey?.[form.formKey];

      const agg = {
        rowsProcessed: 0,
        submissionsWritten: 0,
        peopleCreated: 0,
        peopleMatched: 0,
        skippedNoIdentifier: 0,
        duplicatesSkipped: 0,
        marketingOptOuts: 0,
        servicesPromoted: 0,
      };
      const unmappedServiceOptions = new Set<string>();

      for (let i = 0; i < parsedRows.length; i += BATCH_SIZE) {
        const chunk = parsedRows
          .slice(i, i + BATCH_SIZE)
          .map((r) => ({ ...r, ...(eventId ? { eventId } : {}) }));
        const res = await ctx.runMutation(internal.formSubmissions.importSubmissionsBatch, {
          chapterId: args.chapterId,
          formKey: form.formKey,
          rows: chunk,
          dryRun: args.dryRun,
        });
        agg.rowsProcessed += res.rowsProcessed;
        agg.submissionsWritten += res.submissionsWritten;
        agg.peopleCreated += res.peopleCreated;
        agg.peopleMatched += res.peopleMatched;
        agg.skippedNoIdentifier += res.skippedNoIdentifier;
        agg.duplicatesSkipped += res.duplicatesSkipped;
        agg.marketingOptOuts += res.marketingOptOuts;
        agg.servicesPromoted += res.servicesPromoted;
        for (const u of res.unmappedServiceOptions) unmappedServiceOptions.add(u);
      }

      perForm.push({
        formKey: form.formKey,
        title: form.title,
        fileFound: true,
        ...agg,
        unmappedServiceOptions: [...unmappedServiceOptions],
      });
    }

    const totals = perForm.reduce(
      (acc, f) => ({
        submissionsWritten: acc.submissionsWritten + f.submissionsWritten,
        peopleCreated: acc.peopleCreated + f.peopleCreated,
        peopleMatched: acc.peopleMatched + f.peopleMatched,
      }),
      { submissionsWritten: 0, peopleCreated: 0, peopleMatched: 0 },
    );

    return { dryRun: args.dryRun, csvDir: dir, perForm, totals };
  },
});
