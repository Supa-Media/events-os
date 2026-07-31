/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import type { ExportSectionId } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { peopleBuilders } from "../lib/exportBuilders/people";
import { formSubmissionsBuilders } from "../lib/exportBuilders/formSubmissions";
import type { ExportBuilderContext } from "../lib/exportBuilders/types";
import type { Doc, Id } from "../_generated/dataModel";
import { mergePeopleCore } from "../dataHygiene";

/**
 * People export builder — proves the `form_answers` section (the headline
 * column-alignment contract) plus the filters/exclusions every caller of
 * this builder relies on, and the `mergePeople` regression this feature's
 * bug fix addresses (formSubmissions/personAudit re-pointing).
 */

const peopleBuilder = peopleBuilders[0];

function bctx(
  chapterId: Id<"chapters">,
  sections: ExportSectionId[],
  filters: ExportBuilderContext["filters"] = {},
): ExportBuilderContext {
  return {
    scope: chapterId,
    chapterId,
    filters,
    sections: new Set(sections),
    reach: { giving: true, finance: true },
  };
}

async function seedPerson(
  s: ChapterSetup,
  fields: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, createdAt: Date.now(), ...fields }),
  );
}

async function seedForm(
  s: ChapterSetup,
  args: {
    formKey: string;
    title: string;
    questions: { key: string; label: string; type: "text" | "multiselect"; options?: string[] }[];
  },
): Promise<Id<"formDefinitions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("formDefinitions", {
      chapterId: s.chapterId,
      formKey: args.formKey,
      title: args.title,
      questions: args.questions,
      createdAt: Date.now(),
    }),
  );
}

async function seedSubmission(
  s: ChapterSetup,
  args: {
    formKey: string;
    personId?: Id<"people">;
    eventId?: Id<"events">;
    submittedAt: number;
    answers: Record<string, unknown>;
  },
): Promise<Id<"formSubmissions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("formSubmissions", {
      chapterId: s.chapterId,
      formKey: args.formKey,
      personId: args.personId,
      eventId: args.eventId,
      submittedAt: args.submittedAt,
      answers: args.answers,
      source: "in_app",
      createdAt: args.submittedAt,
    }),
  );
}

describe("peopleBuilders — form_answers section", () => {
  test("a person's answers across TWO forms land in the right columns, multi-select flattens with '; ', empty cells never shift", async () => {
    const s = await setupChapter(newT());

    await seedForm(s, {
      formKey: "contact_information",
      title: "Contact Information",
      questions: [
        { key: "phone_pref", label: "Preferred phone", type: "text" },
        { key: "interests", label: "Interests", type: "multiselect", options: ["Music", "Media", "Prayer"] },
      ],
    });
    await seedForm(s, {
      formKey: "team_interest",
      title: "Team Interest",
      questions: [{ key: "team", label: "Which team?", type: "text" }],
    });

    const withAnswers = await seedPerson(s, { name: "Answered Andy" });
    const withNothing = await seedPerson(s, { name: "Blank Bea" });

    await seedSubmission(s, {
      formKey: "contact_information",
      personId: withAnswers,
      submittedAt: Date.parse("2026-01-01T00:00:00Z"),
      answers: { phone_pref: "text me", interests: ["Music", "Media"] },
    });
    await seedSubmission(s, {
      formKey: "team_interest",
      personId: withAnswers,
      submittedAt: Date.parse("2026-01-02T00:00:00Z"),
      answers: { team: "Worship" },
    });

    const context = bctx(s.chapterId, ["form_answers"]);
    const columns = await run(s.t, (ctx) => peopleBuilder.columns(ctx, context));
    const page = await run(s.t, (ctx) => peopleBuilder.page(ctx, context, null, 50));

    const contactPhoneCol = "form:contact_information:phone_pref";
    const contactInterestsCol = "form:contact_information:interests";
    const teamCol = "form:team_interest:team";
    const contactSubmittedCol = "form:contact_information:__submitted_at__";
    const teamSubmittedCol = "form:team_interest:__submitted_at__";

    const colKeys = columns.map((c) => c.key);
    expect(colKeys).toEqual(
      expect.arrayContaining([
        "person_id",
        "name",
        contactPhoneCol,
        contactInterestsCol,
        contactSubmittedCol,
        teamCol,
        teamSubmittedCol,
      ]),
    );

    const rowsByPerson = Object.fromEntries(page.rows.map((r) => [r.person_id, r]));
    const andyRow = rowsByPerson[withAnswers];
    expect(andyRow[contactPhoneCol]).toBe("text me");
    // Multi-select flattens with "; ".
    expect(andyRow[contactInterestsCol]).toBe("Music; Media");
    expect(andyRow[teamCol]).toBe("Worship");
    expect(andyRow[contactSubmittedCol]).toBe(new Date(Date.parse("2026-01-01T00:00:00Z")).toISOString());
    expect(andyRow[teamSubmittedCol]).toBe(new Date(Date.parse("2026-01-02T00:00:00Z")).toISOString());

    // A person with NO submissions gets empty cells, not shifted columns —
    // the row's cell count must equal the header count.
    const beaRow = rowsByPerson[withNothing];
    expect(beaRow[contactPhoneCol]).toBe("");
    expect(beaRow[contactInterestsCol]).toBe("");
    expect(beaRow[teamCol]).toBe("");
    expect(Object.keys(beaRow).length).toBe(colKeys.length);
    expect(Object.keys(andyRow).length).toBe(colKeys.length);
  });

  test("re-submitting the same form keeps the MOST RECENT answer", async () => {
    const s = await setupChapter(newT());
    await seedForm(s, {
      formKey: "pop_the_balloon",
      title: "Pop The Balloon",
      questions: [{ key: "answer", label: "Your answer", type: "text" }],
    });
    const personId = await seedPerson(s, { name: "Resubmitter Rae" });

    await seedSubmission(s, {
      formKey: "pop_the_balloon",
      personId,
      submittedAt: Date.parse("2026-01-01T00:00:00Z"),
      answers: { answer: "first try" },
    });
    await seedSubmission(s, {
      formKey: "pop_the_balloon",
      personId,
      submittedAt: Date.parse("2026-03-01T00:00:00Z"),
      answers: { answer: "second try" },
    });

    const context = bctx(s.chapterId, ["form_answers"]);
    const page = await run(s.t, (ctx) => peopleBuilder.page(ctx, context, null, 50));
    const row = page.rows.find((r) => r.person_id === personId)!;
    expect(row["form:pop_the_balloon:answer"]).toBe("second try");
    expect(row["form:pop_the_balloon:__submitted_at__"]).toBe(
      new Date(Date.parse("2026-03-01T00:00:00Z")).toISOString(),
    );
  });
});

describe("peopleBuilders — filters and exclusions", () => {
  test("rosterOnly drops isContactOnly rows; placeholders/sample people never appear", async () => {
    const s = await setupChapter(newT());
    const roster = await seedPerson(s, { name: "On Roster" });
    const contactOnly = await seedPerson(s, { name: "Contact Only", isContactOnly: true });
    const placeholder = await seedPerson(s, { name: "Placeholder", isPlaceholder: true });
    const sample = await seedPerson(s, { name: "Sample Person", isSamplePerson: true });

    const context = bctx(s.chapterId, ["contact"], { rosterOnly: true });
    const page = await run(s.t, (ctx) => peopleBuilder.page(ctx, context, null, 50));
    const ids = page.rows.map((r) => r.person_id);

    expect(ids).toContain(roster);
    expect(ids).not.toContain(contactOnly);
    expect(ids).not.toContain(placeholder);
    expect(ids).not.toContain(sample);
  });

  test("without rosterOnly, isContactOnly rows still appear (only placeholders/samples are always excluded)", async () => {
    const s = await setupChapter(newT());
    const contactOnly = await seedPerson(s, { name: "Contact Only", isContactOnly: true });

    const context = bctx(s.chapterId, ["contact"]);
    const page = await run(s.t, (ctx) => peopleBuilder.page(ctx, context, null, 50));
    expect(page.rows.map((r) => r.person_id)).toContain(contactOnly);
  });
});

describe("formSubmissionsBuilders", () => {
  test("one row per submission, columns keyed by form + question, anonymous (person-less) rows included", async () => {
    const s = await setupChapter(newT());
    await seedForm(s, {
      formKey: "contact_information",
      title: "Contact Information",
      questions: [{ key: "q1", label: "Q1", type: "text" }],
    });
    const personId = await seedPerson(s, { name: "Submitter Sam" });
    await seedSubmission(s, {
      formKey: "contact_information",
      personId,
      submittedAt: Date.parse("2026-02-01T00:00:00Z"),
      answers: { q1: "hi" },
    });
    // Anonymous submission: no personId at all (mirrors an anonymous event
    // survey — no eventId fixture needed to prove the person-less path works).
    await seedSubmission(s, {
      formKey: "contact_information",
      submittedAt: Date.parse("2026-02-02T00:00:00Z"),
      answers: { q1: "anon answer" },
    });

    const builder = formSubmissionsBuilders[0];
    const context = bctx(s.chapterId, []);
    const columns = await run(s.t, (ctx) => builder.columns(ctx, context));
    const page = await run(s.t, (ctx) => builder.page(ctx, context, null, 50));

    expect(columns.map((c) => c.key)).toContain("form:contact_information:q1");
    expect(page.rows).toHaveLength(2);

    const named = page.rows.find((r) => r.person_id === personId)!;
    expect(named["form:contact_information:q1"]).toBe("hi");

    const anon = page.rows.find((r) => r.person_id === "")!;
    expect(anon["form:contact_information:q1"]).toBe("anon answer");
    expect(anon.person_name).toBe("");
  });
});

describe("dataHygiene mergePeople — formSubmissions/personAudit repoint (bug fix regression)", () => {
  test("merging two people moves the duplicate's form submissions AND person-audit rows onto the survivor", async () => {
    const s = await setupChapter(newT());
    const survivorId = await seedPerson(s, { name: "Survivor", email: "survivor@example.com" });
    const duplicateId = await seedPerson(s, { name: "Duplicate Dup" });

    await seedForm(s, {
      formKey: "contact_information",
      title: "Contact Information",
      questions: [{ key: "q1", label: "Q1", type: "text" }],
    });
    const submissionId = await seedSubmission(s, {
      formKey: "contact_information",
      personId: duplicateId,
      submittedAt: Date.now(),
      answers: { q1: "answer" },
    });
    const auditId = await run(s.t, (ctx) =>
      ctx.db.insert("personAudit", {
        personId: duplicateId,
        chapterId: s.chapterId,
        actorUserId: s.userId,
        at: Date.now(),
        changes: [{ field: "email", from: undefined, to: "dup@example.com" }],
      }),
    );

    const result = await run(s.t, (ctx) =>
      mergePeopleCore(ctx, { chapterId: s.chapterId, survivorId, duplicateId }),
    );

    const submission = await run(s.t, (ctx) => ctx.db.get(submissionId));
    const audit = await run(s.t, (ctx) => ctx.db.get(auditId));
    expect(submission?.personId).toBe(survivorId);
    expect(audit?.personId).toBe(survivorId);
    expect(result.repointed.formSubmissions).toBe(1);
    expect(result.repointed.personAudit).toBe(1);

    // The duplicate is gone but its form submission is still reachable —
    // exactly what this feature's export exists to surface.
    expect(await run(s.t, (ctx) => ctx.db.get(duplicateId))).toBeNull();

    const context = bctx(s.chapterId, ["form_answers"]);
    const page = await run(s.t, (ctx) => peopleBuilder.page(ctx, context, null, 50));
    const survivorRow = page.rows.find((r) => r.person_id === survivorId)!;
    expect(survivorRow["form:contact_information:q1"]).toBe("answer");
  });
});
