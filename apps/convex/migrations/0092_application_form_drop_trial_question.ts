import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Drop the Empowerment Trial question from the application form
 * (2026-10-13).
 *
 * The founder asked for "Every role starts with an Empowerment Trial — …
 * What would you want yours to be?" to come off `/team/apply`. The code
 * default no longer has it; this removes it from the stored row, which the
 * desk had saved in the OS. Matched by key (`trial`), so a reworded copy
 * goes too. Old applications keep their answers and the labels they were
 * asked (`jobApplications.questions`).
 *
 * Idempotent: a second run finds no `trial` question. Never empties the
 * form, which needs at least one question.
 */
export async function runApplicationFormDropTrialQuestion(ctx: MutationCtx) {
  const row = await ctx.db.query("applicationForm").first();
  if (!row) return { changed: 0 };
  const questions = row.questions.filter((q) => q.key !== "trial");
  const changed = row.questions.length - questions.length;
  if (changed === 0 || questions.length === 0) return { changed: 0 };
  await ctx.db.patch(row._id, { questions, updatedAt: Date.now() });
  return { changed };
}

export const applicationFormDropTrialQuestion: Migration = {
  name: "0092_application_form_drop_trial_question",
  run: runApplicationFormDropTrialQuestion,
};
