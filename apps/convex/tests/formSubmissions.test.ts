/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/**
 * Form Submissions (`formSubmissions.ts`) — the internal import write path
 * (`importSubmissionsBatch`) and the read surfaces (`listForPerson`,
 * `listForEvent`, `summaryForEvent`) it feeds. `lib/formCatalog.test.ts`
 * covers the pure CSV parsing; this suite covers the DB-facing contract:
 * person match-or-create, idempotency, the two promotions (consent →
 * `marketingOptOut`, Team Interest → `serviceIds`), event-scoped anonymous
 * submissions, rating aggregation, and access gating.
 */

async function seedEvent(s: ChapterSetup, name = "Eden: Worship & Picnic"): Promise<Id<"events">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Community Event",
      slug: "community-event",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Seed just enough of the org-wide Service Catalog for the Team Interest
 *  promotion test: a top-level "Event Coordination" option and an
 *  "Evangelism" / "Prayer & Intercession" pair (mirrors
 *  `lib/serviceCatalog.ts#CANONICAL_SERVICE_CATALOG`'s real shape). */
async function seedServiceCatalog(t: ReturnType<typeof newT>) {
  return run(t, async (ctx) => {
    const now = Date.now();
    const eventCoordination = await ctx.db.insert("serviceOptions", {
      name: "Event Coordination",
      isActive: true,
      createdAt: now,
    });
    const evangelism = await ctx.db.insert("serviceOptions", {
      name: "Evangelism",
      isActive: true,
      createdAt: now,
    });
    const prayer = await ctx.db.insert("serviceOptions", {
      name: "Prayer & Intercession",
      isActive: true,
      createdAt: now,
    });
    return { eventCoordination, evangelism, prayer };
  });
}

describe("importSubmissionsBatch — person-scoped form", () => {
  test("dry-run writes nothing; execute creates/matches people + submissions; idempotent re-run", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const rows = [
      {
        submittedAt: 1_700_000_000_000,
        name: "Lauryn Lebron",
        email: "lebronn.1128@gmail.com",
        answers: { name: "Lauryn Lebron", email: "lebronn.1128@gmail.com", consent: "Yes" },
      },
    ];

    const dry = await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "contact_information",
      rows,
      dryRun: true,
    });
    expect(dry).toMatchObject({ submissionsWritten: 1, peopleCreated: 1, peopleMatched: 0 });

    // Dry-run truly wrote nothing.
    const peopleAfterDry = await run(t, (ctx) =>
      ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(peopleAfterDry).toHaveLength(0);
    const submissionsAfterDry = await run(t, (ctx) =>
      ctx.db.query("formSubmissions").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(submissionsAfterDry).toHaveLength(0);

    const first = await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "contact_information",
      rows,
      dryRun: false,
    });
    expect(first).toMatchObject({ submissionsWritten: 1, peopleCreated: 1, peopleMatched: 0 });

    const people = await run(t, (ctx) =>
      ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ email: "lebronn.1128@gmail.com", isContactOnly: true });
    const submissions = await run(t, (ctx) =>
      ctx.db.query("formSubmissions").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      formKey: "contact_information",
      personId: people[0]._id,
      submittedAt: 1_700_000_000_000,
      source: "google_forms_import",
    });

    // Re-running the SAME rows (execute) creates no duplicate person or
    // submission — matched, not created; the submission dedupes on
    // (formKey, personId, submittedAt) and is skipped.
    const second = await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "contact_information",
      rows,
      dryRun: false,
    });
    expect(second).toMatchObject({
      submissionsWritten: 0,
      peopleCreated: 0,
      peopleMatched: 1,
      duplicatesSkipped: 1,
    });
    const peopleAfterRerun = await run(t, (ctx) =>
      ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(peopleAfterRerun).toHaveLength(1);
    const submissionsAfterRerun = await run(t, (ctx) =>
      ctx.db.query("formSubmissions").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(submissionsAfterRerun).toHaveLength(1);

    // A `formDefinitions` row was seeded exactly once too.
    const defs = await run(t, (ctx) =>
      ctx.db.query("formDefinitions").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(defs).toHaveLength(1);
    expect(defs[0].formKey).toBe("contact_information");
  });

  test("a name-only row (no email/phone) is skipped, never creates a person", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const result = await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "contact_information",
      rows: [
        {
          submittedAt: Date.now(),
          name: "No Contact Info",
          answers: { name: "No Contact Info", consent: "Yes" },
        },
      ],
      dryRun: false,
    });
    expect(result).toMatchObject({ submissionsWritten: 0, skippedNoIdentifier: 1 });
    const people = await run(t, (ctx) =>
      ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(people).toHaveLength(0);
  });

  test("consent 'No' sets marketingOptOut: true; 'Yes' never does", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "contact_information",
      rows: [
        {
          submittedAt: 1,
          name: "Opts Out",
          email: "opts-out@example.com",
          answers: { name: "Opts Out", email: "opts-out@example.com", consent: "No" },
        },
        {
          submittedAt: 2,
          name: "Opts In",
          email: "opts-in@example.com",
          answers: { name: "Opts In", email: "opts-in@example.com", consent: "Yes" },
        },
      ],
      dryRun: false,
    });
    const people = await run(t, (ctx) =>
      ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    const optedOut = people.find((p) => p.email === "opts-out@example.com")!;
    const optedIn = people.find((p) => p.email === "opts-in@example.com")!;
    expect(optedOut.marketingOptOut).toBe(true);
    expect(optedIn.marketingOptOut).toBeUndefined();
  });

  test("Team Interest promotes matched service checkboxes onto serviceIds, including a 1-to-2 mapping", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventCoordination, evangelism, prayer } = await seedServiceCatalog(t);

    const result = await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "team_interest",
      rows: [
        {
          submittedAt: 1,
          name: "Volunteer Vee",
          email: "vee@example.com",
          answers: {
            name: "Volunteer Vee",
            email: "vee@example.com",
            services_selected: ["Event Coordinator", "In person Evangelism and Prayer"],
          },
        },
      ],
      dryRun: false,
    });
    expect(result.servicesPromoted).toBe(3); // Event Coordination + Evangelism + Prayer & Intercession
    expect(result.unmappedServiceOptions).toEqual([]);

    const people = await run(t, (ctx) =>
      ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    expect(people[0].serviceIds?.sort()).toEqual(
      [eventCoordination, evangelism, prayer].sort(),
    );
  });
});

describe("importSubmissionsBatch — event-scoped anonymous form", () => {
  test("a submission with eventId and no personId is valid and reads back via listForEvent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    const result = await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "eden_survey",
      rows: [
        {
          submittedAt: 1,
          eventId,
          answers: { rating_overall: "Good" },
        },
      ],
      dryRun: false,
    });
    expect(result).toMatchObject({ submissionsWritten: 1, peopleCreated: 0, peopleMatched: 0 });

    const stored = await run(t, (ctx) =>
      ctx.db.query("formSubmissions").withIndex("by_event", (q) => q.eq("eventId", eventId)).collect(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].personId).toBeUndefined();
    expect(stored[0].eventId).toBe(eventId);

    const viaApi = await s.as.query(api.formSubmissions.listForEvent, { eventId });
    expect(viaApi).toHaveLength(1);
    expect(viaApi[0].personId).toBeUndefined();
  });

  test("summaryForEvent aggregates rating counts + averages across submissions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "eden_survey",
      rows: [
        { submittedAt: 1, eventId, answers: { rating_overall: "Good" } },
        { submittedAt: 2, eventId, answers: { rating_overall: "Excellent" } },
        { submittedAt: 3, eventId, answers: { rating_overall: "Excellent" } },
      ],
      dryRun: false,
    });

    const summary = await s.as.query(api.formSubmissions.summaryForEvent, { eventId });
    expect(summary.totalSubmissions).toBe(3);
    expect(summary.ratings.rating_overall.counts).toEqual({ Good: 1, Excellent: 2 });
    // (3 [Good] + 4 [Excellent] + 4 [Excellent]) / 3 = 11/3
    expect(summary.ratings.rating_overall.average).toBeCloseTo(11 / 3);
  });
});

describe("access gating", () => {
  test("a caller outside the chapter cannot read another chapter's submissions", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Chapter A" });
    const other = await setupChapter(t, { email: "leader2@publicworship.life", chapterName: "Chapter B" });

    const personId = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Solo Person",
        email: "solo@example.com",
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.formSubmissions.importSubmissionsBatch, {
      chapterId: s.chapterId,
      formKey: "contact_information",
      rows: [
        {
          submittedAt: 1,
          name: "Solo Person",
          email: "solo@example.com",
          answers: { name: "Solo Person", email: "solo@example.com" },
        },
      ],
      dryRun: false,
    });

    await expect(
      other.as.query(api.formSubmissions.listForPerson, { personId }),
    ).rejects.toThrow(ConvexError);
    // The owning chapter's own caller can read it fine.
    const rows = await s.as.query(api.formSubmissions.listForPerson, { personId });
    expect(rows).toHaveLength(1);
  });
});
