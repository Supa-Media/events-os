import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import {
  APPLICATION_FORM_LIMITS,
  DEFAULT_APPLICATION_QUESTIONS,
} from "@events-os/shared";

/**
 * Add the monthly all-team meeting question to the stored application form
 * (2026-10-14).
 *
 * The founder asked that applicants say whether they can join the mandatory
 * all-team meeting on the first Thursday of every month. The code default
 * already carries it (`monthlyMeeting`, a required yes/no); this adds it to
 * the row the desk saved in the OS, right after the hours question
 * (`capacity`) where the defaults put it, or at the end if the desk removed
 * that one. Nothing else the desk wrote changes.
 *
 * Idempotent by content: a second run finds `monthlyMeeting` already there.
 */
export async function runApplicationFormMonthlyMeetingQuestion(ctx: MutationCtx) {
  const row = await ctx.db.query("applicationForm").first();
  if (!row) return { changed: 0 };
  const next = DEFAULT_APPLICATION_QUESTIONS.find((q) => q.key === "monthlyMeeting");
  if (!next) throw new Error("DEFAULT_APPLICATION_QUESTIONS lost `monthlyMeeting`");
  if (row.questions.some((q) => q.key === "monthlyMeeting")) return { changed: 0 };
  // A full form can't take another question without failing its own save.
  if (row.questions.length >= APPLICATION_FORM_LIMITS.maxQuestions) {
    return { changed: 0 };
  }
  const after = row.questions.findIndex((q) => q.key === "capacity");
  const at = after === -1 ? row.questions.length : after + 1;
  const questions = [...row.questions];
  questions.splice(at, 0, { ...next });
  await ctx.db.patch(row._id, { questions, updatedAt: Date.now() });
  return { changed: 1 };
}

export const applicationFormMonthlyMeetingQuestion: Migration = {
  name: "0093_application_form_monthly_meeting_question",
  run: runApplicationFormMonthlyMeetingQuestion,
};
