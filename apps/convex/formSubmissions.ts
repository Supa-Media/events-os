/**
 * Form Submissions (PW Forms consolidation) — reads for the person detail
 * sheet's "Form submissions" section and an event's "Feedback" card, plus
 * the internal write path the one-off Google Forms import
 * (`formSubmissionsImport.ts`) drives. See `schema/forms.ts`'s module doc
 * for the person-vs-event modeling split and `lib/formCatalog.ts` for the
 * 6-form catalog + CSV parsing this import reuses.
 *
 * Access is gated through the NAMED resolver in `lib/formsAccess.ts` (per
 * CLAUDE.md's "Gate It Behind a Power" section) — never an inline chapter
 * check here.
 */
import { v, ConvexError } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
// Triggers-wrapped builder for `importSubmissionsBatch` below (writes
// `people` via `matchOrCreatePersonContact`) — see
// `lib/peopleAggregate.ts`'s module doc.
import { internalMutation as triggerInternalMutation } from "./lib/peopleAggregate";
import { requireViewFormSubmissions } from "./lib/formsAccess";
import { matchIdentity, matchOrCreatePersonContact } from "./givingImport";
import { hasPersonIdentifier } from "./lib/givingDonors";
import { chapterRoster } from "./lib/org";
import {
  FORM_CATALOG,
  RATING_SCALE,
  EDEN_RATING_KEYS,
  findFormByKey,
  isMarketingOptOut,
  resolveTeamInterestServiceIds,
  toFormDefinitionRow,
  type FormDefinition,
} from "./lib/formCatalog";

/** Generous bound for a single person's/event's submission history — this
 *  app's real volume (335 rows across 6 forms) is nowhere near this. */
const SUBMISSIONS_READ_CAP = 200;
/** Bound for the same-person/same-event dedupe scan the import uses — a
 *  respondent doesn't submit the SAME form hundreds of times. */
const DEDUPE_SCAN_LIMIT = 500;
/** Generous bound over the ~47-row canonical Service Catalog (mirrors
 *  `lib/serviceCatalog.ts`'s own `CATALOG_SCAN_LIMIT`). */
const SERVICE_CATALOG_SCAN_LIMIT = 1000;

/** `formKey` → human title, e.g. "Team Interest" — resolved server-side
 *  (from `lib/formCatalog.ts`, falling back to the raw key for a future
 *  in-app form this catalog doesn't know about yet) so mobile/web readers
 *  never need their own copy of the form catalog just to render a label. */
function submissionView(row: Doc<"formSubmissions">) {
  return {
    _id: row._id,
    formKey: row.formKey,
    title: findFormByKey(row.formKey)?.title ?? row.formKey,
    eventId: row.eventId,
    personId: row.personId,
    submittedAt: row.submittedAt,
    answers: row.answers,
    source: row.source,
  };
}

const submissionValidator = v.object({
  _id: v.id("formSubmissions"),
  formKey: v.string(),
  title: v.string(),
  eventId: v.optional(v.id("events")),
  personId: v.optional(v.id("people")),
  submittedAt: v.number(),
  answers: v.record(v.string(), v.any()),
  source: v.union(v.literal("google_forms_import"), v.literal("in_app")),
});

/** A person's form submissions (People-CRM UX), newest first. Gated via
 *  `formsAccess.ts` on the PERSON's own chapter. */
export const listForPerson = query({
  args: { personId: v.id("people") },
  returns: v.array(submissionValidator),
  handler: async (ctx, { personId }) => {
    const person = await ctx.db.get(personId);
    if (!person) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Person not found." });
    }
    await requireViewFormSubmissions(ctx, person.chapterId);
    const rows = await ctx.db
      .query("formSubmissions")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .take(SUBMISSIONS_READ_CAP);
    return rows.sort((a, b) => b.submittedAt - a.submittedAt).map(submissionView);
  },
});

/** An event's form submissions (the Feedback card's raw list), newest
 *  first. Gated via `formsAccess.ts` on the EVENT's own chapter. */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  returns: v.array(submissionValidator),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    }
    await requireViewFormSubmissions(ctx, event.chapterId);
    const rows = await ctx.db
      .query("formSubmissions")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(SUBMISSIONS_READ_CAP);
    return rows.sort((a, b) => b.submittedAt - a.submittedAt).map(submissionView);
  },
});

/**
 * Aggregate rating stats for an event's survey responses (the Eden-style
 * "How would you rate…" questions, `lib/formCatalog.ts#EDEN_RATING_KEYS`) —
 * a per-key value distribution + an average score (`RATING_SCALE`'s
 * position, 1-indexed) when every observed value for that key falls within
 * the known rating scale. Generic over whichever rating-style keys actually
 * appear in this event's submissions, so a future event-scoped survey with
 * its own "How would you rate…" questions is aggregated the same way
 * without code changes here.
 */
export const summaryForEvent = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    totalSubmissions: v.number(),
    ratings: v.record(
      v.string(),
      v.object({
        counts: v.record(v.string(), v.number()),
        average: v.union(v.number(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    }
    await requireViewFormSubmissions(ctx, event.chapterId);
    const rows = await ctx.db
      .query("formSubmissions")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(SUBMISSIONS_READ_CAP);

    const ratingKeys = new Set<string>(EDEN_RATING_KEYS);
    // Also pick up any OTHER select-type answer whose value is a rating-scale
    // word, in case a future event survey reuses the scale under a different key.
    for (const row of rows) {
      for (const [key, value] of Object.entries(row.answers)) {
        if (typeof value === "string" && (RATING_SCALE as readonly string[]).includes(value)) {
          ratingKeys.add(key);
        }
      }
    }

    const ratings: Record<string, { counts: Record<string, number>; average: number | null }> = {};
    for (const key of ratingKeys) {
      const counts: Record<string, number> = {};
      let sum = 0;
      let scored = 0;
      let allInScale = true;
      for (const row of rows) {
        const value = row.answers[key];
        if (typeof value !== "string" || value.length === 0) continue;
        counts[value] = (counts[value] ?? 0) + 1;
        const scaleIndex = (RATING_SCALE as readonly string[]).indexOf(value);
        if (scaleIndex === -1) {
          allInScale = false;
        } else {
          sum += scaleIndex + 1;
          scored++;
        }
      }
      if (Object.keys(counts).length === 0) continue;
      ratings[key] = {
        counts,
        average: allInScale && scored > 0 ? sum / scored : null,
      };
    }

    return { totalSubmissions: rows.length, ratings };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Internal write path — the one-off Google Forms import
// (`formSubmissionsImport.ts`'s "use node" action calls this in batches).
// ═══════════════════════════════════════════════════════════════════════════

/** Mirrors `lib/serviceCatalog.ts#ensureOrgWideServiceCatalog`'s label→id
 *  construction, READ-ONLY (this import never needs to CREATE catalog rows —
 *  the Service Catalog is already seeded by migration 0046 on this branch's
 *  base — so it never risks writing during a `dryRun` call). */
async function buildOrgServiceLabelToId(
  ctx: QueryCtx,
): Promise<Map<string, Id<"serviceOptions">>> {
  const rows = await ctx.db
    .query("serviceOptions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", undefined))
    .take(SERVICE_CATALOG_SCAN_LIMIT);
  const byId = new Map(rows.map((r) => [r._id, r]));
  const labelToId = new Map<string, Id<"serviceOptions">>();
  for (const r of rows) {
    if (r.parentId) {
      const parent = byId.get(r.parentId);
      if (parent) labelToId.set(`${parent.name}:${r.name}`.toLowerCase(), r._id);
    } else {
      labelToId.set(r.name.toLowerCase(), r._id);
    }
  }
  return labelToId;
}

/** Idempotency check: has THIS exact response already been imported? Matched
 *  by (formKey, personId-or-eventId, submittedAt) — the real Google Forms
 *  timestamp is a reliable natural key for "the same response", and a
 *  bounded per-person/per-event scan (never more than a handful of that
 *  form's rows for one person/event) avoids a table-wide lookup. */
async function findExistingSubmission(
  ctx: QueryCtx,
  opts: { formKey: string; personId?: Id<"people">; eventId?: Id<"events">; submittedAt: number },
): Promise<boolean> {
  if (opts.personId) {
    const rows = await ctx.db
      .query("formSubmissions")
      .withIndex("by_person", (q) => q.eq("personId", opts.personId))
      .take(DEDUPE_SCAN_LIMIT);
    return rows.some((r) => r.formKey === opts.formKey && r.submittedAt === opts.submittedAt);
  }
  if (opts.eventId) {
    const rows = await ctx.db
      .query("formSubmissions")
      .withIndex("by_event", (q) => q.eq("eventId", opts.eventId))
      .take(DEDUPE_SCAN_LIMIT);
    return rows.some((r) => r.formKey === opts.formKey && r.submittedAt === opts.submittedAt);
  }
  return false;
}

/** Seed (or confirm) this chapter's `formDefinitions` row for `form` — a
 *  one-time, idempotent write (skipped entirely on `dryRun`, which never
 *  writes anything). */
async function ensureFormDefinitionRow(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  form: FormDefinition,
): Promise<void> {
  const existing = await ctx.db
    .query("formDefinitions")
    .withIndex("by_form", (q) => q.eq("formKey", form.formKey))
    .take(50);
  if (existing.some((r) => r.chapterId === chapterId)) return;
  await ctx.db.insert("formDefinitions", {
    chapterId,
    ...toFormDefinitionRow(form),
    createdAt: Date.now(),
  });
}

const importRowValidator = v.object({
  submittedAt: v.number(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  answers: v.record(v.string(), v.any()),
  // Set by the caller for an event-scoped form (Eden) — see
  // `formSubmissionsImport.ts`'s `eventIdByFormKey` arg.
  eventId: v.optional(v.id("events")),
});

/**
 * Batched import commit (or dry-run preview) for ONE form's rows — called
 * repeatedly by `formSubmissionsImport.ts`'s action, chunked so each call
 * stays comfortably within one mutation's read/write budget. Idempotent
 * (re-running the same rows creates no duplicate people or submissions —
 * see `findExistingSubmission` + `matchOrCreatePersonContact`'s own
 * match-before-insert contract) and NEVER writes when `dryRun: true` — the
 * two-phase preview/commit split every import in this app follows
 * (`givingImport.ts`, `peopleImport.ts`): dry-run previews identity
 * resolution with the read-only `matchIdentity` against an in-memory pool
 * (mirrors `previewContactsImport`); execute uses the real
 * `matchOrCreatePersonContact` writer.
 *
 * PROMOTIONS (this PR only promotes what's unambiguous — see
 * `lib/formCatalog.ts`'s module doc for what's deliberately left in
 * `answers` for the sibling `feat/person-form-fields` branch to promote
 * later):
 *   - Contact Information's consent === "No" → `people.marketingOptOut: true`
 *     (never the reverse — a "Yes"/anything else never CLEARS an existing
 *     opt-out here).
 *   - Team Interest's matched service checkboxes → `people.serviceIds`
 *     (additive union with whatever the person already has).
 */
export const importSubmissionsBatch = triggerInternalMutation({
  args: {
    chapterId: v.id("chapters"),
    formKey: v.string(),
    rows: v.array(importRowValidator),
    dryRun: v.boolean(),
  },
  returns: v.object({
    formKey: v.string(),
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
  handler: async (ctx, args) => {
    const form = findFormByKey(args.formKey);
    if (!form) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: `Unknown formKey "${args.formKey}" — not in lib/formCatalog.ts#FORM_CATALOG.`,
      });
    }
    if (!args.dryRun) {
      await ensureFormDefinitionRow(ctx, args.chapterId, form);
    }

    // One roster load for the whole batch — every insert (execute mode) or
    // simulated insert (dry-run) joins the pool so within-batch duplicates
    // match instead of double-creating/double-counting (mirrors
    // `peopleImport.ts#importContacts`).
    const roster: Doc<"people">[] =
      form.scope === "person" ? await chapterRoster(ctx, args.chapterId) : [];
    // Dry-run's own simulated pool + planned-insert dedupe set (mirrors
    // `previewContactsImport`) — never touches the real `roster` array above.
    // Keeps each EXISTING row's real `_id` (unlike a brand-new planned
    // insert, which has none yet) so a dry-run can still preview accurate
    // submission-dedupe against an already-imported person — see the
    // `personId` assignment below.
    const previewPool: { _id?: Id<"people">; name: string; email?: string; phone?: string }[] =
      roster.map((p) => ({ _id: p._id, name: p.name, email: p.email, phone: p.phone }));
    const plannedInserts = new Set<string>();

    let labelToId: Map<string, Id<"serviceOptions">> | null = null;
    const ensureLabelToId = async () => {
      if (!labelToId) labelToId = await buildOrgServiceLabelToId(ctx);
      return labelToId;
    };

    let submissionsWritten = 0;
    let peopleCreated = 0;
    let peopleMatched = 0;
    let skippedNoIdentifier = 0;
    let duplicatesSkipped = 0;
    let marketingOptOuts = 0;
    let servicesPromoted = 0;
    const unmappedServiceOptions = new Set<string>();

    for (const row of args.rows) {
      let personId: Id<"people"> | undefined;

      if (form.scope === "person") {
        if (args.dryRun) {
          const { match } = matchIdentity(previewPool, row);
          if (match) {
            peopleMatched++;
            // A real, already-persisted person — safe to preview the
            // submission-dedupe check below against their real id.
            personId = match._id;
          } else if (!hasPersonIdentifier({ email: row.email, phone: row.phone })) {
            skippedNoIdentifier++;
            continue;
          } else {
            const key = `${row.email?.trim().toLowerCase() ?? ""}|${row.phone?.trim() ?? ""}|${row.name?.trim() ?? ""}`;
            if (!plannedInserts.has(key)) {
              plannedInserts.add(key);
              peopleCreated++;
              previewPool.push({ name: row.name ?? "Unknown", email: row.email, phone: row.phone });
            }
            // No real id exists yet in dry-run — a brand-new person can't
            // already have a duplicate submission, so submission-dedupe is
            // trivially "not a duplicate" for this branch (handled below by
            // `personId` staying undefined and the dup check short-circuiting).
          }
        } else {
          const res = await matchOrCreatePersonContact(
            ctx,
            args.chapterId,
            { name: row.name ?? "Unknown", email: row.email, phone: row.phone },
            roster,
          );
          if (res.skipped) {
            skippedNoIdentifier++;
            continue;
          }
          personId = res.personId;
          if (res.isNew) peopleCreated++;
          else peopleMatched++;
        }
      }

      const eventId = row.eventId;

      // Idempotency: only meaningful once we have a REAL id to key off of —
      // an, as-yet-uninserted dry-run person can't have a prior submission.
      if (personId || eventId) {
        const dup = await findExistingSubmission(ctx, {
          formKey: args.formKey,
          personId,
          eventId,
          submittedAt: row.submittedAt,
        });
        if (dup) {
          duplicatesSkipped++;
          continue;
        }
      }

      if (!args.dryRun) {
        await ctx.db.insert("formSubmissions", {
          chapterId: args.chapterId,
          formKey: args.formKey,
          ...(personId ? { personId } : {}),
          ...(eventId ? { eventId } : {}),
          submittedAt: row.submittedAt,
          answers: row.answers,
          source: "google_forms_import",
          createdAt: Date.now(),
        });
      }
      submissionsWritten++;

      // ── Promotions ──────────────────────────────────────────────────────
      if (args.formKey === "contact_information" && isMarketingOptOut(row.answers)) {
        marketingOptOuts++;
        if (!args.dryRun && personId) {
          const person = await ctx.db.get(personId);
          if (person && person.marketingOptOut !== true) {
            await ctx.db.patch(personId, { marketingOptOut: true });
          }
        }
      }

      if (args.formKey === "team_interest") {
        const matched = Array.isArray(row.answers.services_selected)
          ? (row.answers.services_selected as string[])
          : [];
        if (matched.length > 0) {
          const map = await ensureLabelToId();
          const { serviceIds, unmapped } = resolveTeamInterestServiceIds(map, matched);
          for (const u of unmapped) unmappedServiceOptions.add(u);
          if (serviceIds.length > 0) {
            servicesPromoted += serviceIds.length;
            if (!args.dryRun && personId) {
              const person = await ctx.db.get(personId);
              if (person) {
                const existing = new Set(person.serviceIds ?? []);
                for (const id of serviceIds) existing.add(id);
                await ctx.db.patch(personId, { serviceIds: [...existing] });
              }
            }
          }
        }
      }
    }

    return {
      formKey: args.formKey,
      rowsProcessed: args.rows.length,
      submissionsWritten,
      peopleCreated,
      peopleMatched,
      skippedNoIdentifier,
      duplicatesSkipped,
      marketingOptOuts,
      servicesPromoted,
      unmappedServiceOptions: [...unmappedServiceOptions],
    };
  },
});

/** Every catalog form's key + title — for the import action's summary and
 *  any future admin listing of "what forms have been imported". */
export function catalogSummary(): { formKey: string; title: string }[] {
  return FORM_CATALOG.map((f) => ({ formKey: f.formKey, title: f.title }));
}
