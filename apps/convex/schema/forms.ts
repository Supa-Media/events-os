import { defineTable } from "convex/server";
import { v } from "convex/values";
import { COLUMN_TYPES } from "@events-os/shared";

/**
 * Form Submissions — the durable home for every Google Form response the
 * founder has run (Contact Information, Team Interest, event surveys, …),
 * consolidated into ONE table rather than a separate "survey" table per
 * form. A survey and an intake form are the SAME shape (a form submission);
 * two tables of that one shape would defeat the whole point of this PR —
 * putting durable facts on the person and event-scoped answers on the
 * event, without losing anything from the original CSVs.
 *
 * The identity-vs-event split is expressed by which of `personId`/`eventId`
 * is set, never by which table a row lives in:
 *   - `personId` set, `eventId` absent — a PERSON-scoped submission (an
 *     intake/interest form: Contact Information, Team Interest, Pop The
 *     Balloon, …). Durable facts get PROMOTED out onto `people` itself
 *     (name, email, phone, `serviceIds`, …) — see `lib/formCatalog.ts`'s
 *     module doc for exactly what this PR promotes vs. leaves in `answers`
 *     for later; the submission row stays the verbatim record either way.
 *   - `eventId` set, `personId` absent — an ANONYMOUS event survey (the
 *     Eden: Worship & Picnic attendee survey collects no name/email at
 *     all — a real respondent, just not an identified one). `summaryForEvent`
 *     (`formSubmissions.ts`) aggregates these.
 *   - Neither is a valid write path for THIS import (every real form here
 *     collects an email, or is Eden's fully-anonymous survey) but the schema
 *     doesn't forbid a future in-app form that sets neither/both — the
 *     table only ever branches on which optional field is actually present.
 *
 * STORE EVERYTHING VERBATIM, PROMOTE A CURATED FEW: `answers` is the
 * complete record of every column in the source form, keyed by the form's
 * stable `questionKey` (see `formDefinitions.questions[].key`) — nothing is
 * dropped, even fields this PR doesn't yet promote onto `people` (location,
 * referral source, consent timestamp — reserved for the sibling
 * `feat/person-form-fields` branch's schema fields; see
 * `lib/formCatalog.ts`). That's what makes this not-start-from-zero: import
 * 100% now, promote more fields later WITHOUT re-importing.
 */
export const formSubmissions = defineTable({
  chapterId: v.id("chapters"),
  // Stable key into `formDefinitions.formKey` — "contact_information",
  // "team_interest", "eden_survey", … (the full catalog lives in
  // `lib/formCatalog.ts#FORM_CATALOG`).
  formKey: v.string(),
  // Absent for an anonymous event survey (see module doc above).
  personId: v.optional(v.id("people")),
  // Present for a submission that's about a specific event (an event
  // survey today; nothing stops a future person-AND-event form from
  // setting both).
  eventId: v.optional(v.id("events")),
  // The REAL Google Forms response timestamp (parsed from the export's own
  // `Timestamp` column) — never the import's wall-clock time, so
  // history/ordering reflects when the person actually answered.
  submittedAt: v.number(),
  // Verbatim answers, keyed by the form's stable `questionKey` — never the
  // raw CSV header (which can change wording/casing across a form edit;
  // see `lib/formCatalog.ts`'s Pop The Balloon column-merge doc).
  answers: v.record(v.string(), v.any()),
  source: v.union(v.literal("google_forms_import"), v.literal("in_app")),
  createdAt: v.number(),
})
  .index("by_person", ["personId"])
  .index("by_event", ["eventId"])
  .index("by_form", ["formKey"])
  .index("by_chapter", ["chapterId"]);

/**
 * Form Definitions — one row per distinct form (`formKey`), holding its
 * ordered question list so a submission's `answers` record can be rendered
 * without hardcoding labels/types at every read site. Reuses the EXISTING
 * typed-question vocabulary (`COLUMN_TYPES`, `packages/shared`) instead of
 * inventing a second one — a form question is modeled exactly like a grid
 * column (`text`/`select`/`multiselect`/`number`/…).
 *
 * Seeded as DATA in this PR (`lib/formCatalog.ts#FORM_CATALOG`), not
 * authored through a builder UI — a future in-app form builder would write
 * these same rows instead.
 */
export const formDefinitions = defineTable({
  chapterId: v.id("chapters"),
  formKey: v.string(),
  title: v.string(),
  questions: v.array(
    v.object({
      // Stable key `formSubmissions.answers` is keyed by — survives a form
      // edit that only changes wording (see Pop The Balloon's merged
      // near-duplicate columns in `lib/formCatalog.ts`).
      key: v.string(),
      label: v.string(),
      type: v.union(...COLUMN_TYPES.map((t) => v.literal(t))),
      options: v.optional(v.array(v.string())),
    }),
  ),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_form", ["formKey"]);
