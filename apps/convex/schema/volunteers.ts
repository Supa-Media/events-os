import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * VOLUNTEER SIGNUPS — the light half of the People desk.
 *
 * `/serve`'s form lands here: someone who wants to help at a gathering, not
 * someone applying for a seat on the chart (that is `jobApplications`, and see
 * `@events-os/shared`'s `volunteers.ts` for why the two are deliberately not
 * the same pipeline).
 *
 * This table is an INBOX, not a record of a person. A signup that gets
 * answered becomes a real `people` row — `isVolunteer`, with the Service
 * Catalog tags a human confirmed — via `volunteers.addToRoster`, and the row
 * here keeps the `personId` link so the desk can see it is done. Until then
 * nothing lands in the roster, for the same reason an application doesn't:
 * every roster count in the app would drift toward "everyone who ever clicked
 * a button."
 *
 * Write path: `volunteers.submitSignup` (PUBLIC, no auth — same trust model as
 * the application intake and the giving interest form). Reads and triage are
 * gated on the People desk's powers (`lib/hiringAccess.ts`), because one seat
 * is answerable for both pipelines.
 *
 * PII: no public query returns a row or any part of one.
 */

/** The four stages (`VOLUNTEER_STAGES`); `volunteers.test.ts` pins these
 *  against the shared list. */
export const VOLUNTEER_SIGNUP_STAGES = [
  "new",
  "contacted",
  "rostered",
  "archived",
] as const;

export const volunteerSignups = defineTable({
  name: v.string(),
  /** Lowercased at write. Indexed for "have we met them before?". */
  email: v.string(),
  phone: v.optional(v.string()),
  location: v.optional(v.string()),
  /** The areas they picked (`VOLUNTEER_AREAS` ids). Validated at the write
   *  gate; a short, closed list, so a plain array is right here. */
  areas: v.array(v.string()),
  /** "Weekends, and most weekday evenings" — free text on purpose. Volunteer
   *  availability is a sentence, not a grid, and pretending otherwise gets you
   *  a grid nobody fills in truthfully. */
  availability: v.optional(v.string()),
  /** Anything else they wanted to say. */
  message: v.optional(v.string()),
  stage: v.union(...VOLUNTEER_SIGNUP_STAGES.map((s) => v.literal(s))),
  stageChangedAt: v.number(),
  /** Set once `addToRoster` has made them a real person in the CRM. Its
   *  presence is what "rostered" actually means. */
  personId: v.optional(v.id("people")),
  /** Which chapter's roster they landed on. Absent until rostered. */
  chapterId: v.optional(v.id("chapters")),
  handledBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_stage", ["stage"])
  .index("by_createdAt", ["createdAt"])
  .index("by_email", ["email"]);
