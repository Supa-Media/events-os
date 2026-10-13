import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { DEFAULT_APPLICATION_QUESTIONS } from "@events-os/shared";

/**
 * Swap the application form's escalation question for a leadership one
 * (2026-10-13).
 *
 * The founder replaced "Describe a hard call you had to take to someone
 * above you." with a question about leading people: alignment, conflict,
 * an affinity to lead. The code default already carries the new question
 * (`leadership`); this rewrites the stored row, which the desk had saved in
 * the OS. The `escalation` question becomes `leadership` in place, keeping
 * its position, length limit and required setting. Old applications keep
 * their answers and the labels they were asked (`jobApplications.questions`).
 *
 * Idempotent by content: a second run finds no `escalation` question.
 */
export async function runApplicationFormLeadershipQuestion(ctx: MutationCtx) {
  const row = await ctx.db.query("applicationForm").first();
  if (!row) return { changed: 0 };
  const next = DEFAULT_APPLICATION_QUESTIONS.find((q) => q.key === "leadership");
  if (!next) throw new Error("DEFAULT_APPLICATION_QUESTIONS lost `leadership`");
  // A form that already asks `leadership` would end up with two.
  if (row.questions.some((q) => q.key === "leadership")) return { changed: 0 };
  let changed = 0;
  const questions = row.questions.map((q) => {
    if (q.key !== "escalation") return q;
    changed++;
    return { ...q, key: next.key, label: next.label, help: next.help };
  });
  if (changed > 0) {
    await ctx.db.patch(row._id, { questions, updatedAt: Date.now() });
  }
  return { changed };
}

export const applicationFormLeadershipQuestion: Migration = {
  name: "0091_application_form_leadership_question",
  run: runApplicationFormLeadershipQuestion,
};
