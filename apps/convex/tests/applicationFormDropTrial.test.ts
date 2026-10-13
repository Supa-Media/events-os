/**
 * 0092: the stored form's `trial` question is removed, and nothing else the
 * desk wrote changes.
 */
import { describe, expect, test } from "vitest";
import { DEFAULT_APPLICATION_FORM } from "@events-os/shared";
import { newT, run } from "./setup.helpers";
import { runApplicationFormDropTrialQuestion } from "../migrations/0092_application_form_drop_trial_question";

const OLD_TRIAL = {
  key: "trial",
  label: "Every role starts with an Empowerment Trial — real, bounded work before anything is official. What would you want yours to be?",
  help: "Optional. A good answer here has told us more than a resume, more than once.",
  maxLength: 1500,
  required: false,
};

describe("0092_application_form_drop_trial_question", () => {
  test("removes trial and keeps every other question as stored", async () => {
    const t = newT();
    const kept = DEFAULT_APPLICATION_FORM.questions.map((q) =>
      q.key === "why" ? { ...q, label: "Desk wording" } : q,
    );
    await run(t, async (ctx) => {
      await ctx.db.insert("applicationForm", {
        questions: [...kept, OLD_TRIAL],
        requiredFields: DEFAULT_APPLICATION_FORM.requiredFields,
        updatedAt: 1,
      });
    });
    expect(await run(t, runApplicationFormDropTrialQuestion)).toEqual({
      changed: 1,
    });
    const row = await run(t, (ctx) => ctx.db.query("applicationForm").first());
    expect(row!.questions).toEqual(kept);
    expect(await run(t, runApplicationFormDropTrialQuestion)).toEqual({
      changed: 0,
    });
  });

  test("the code default no longer asks it", () => {
    expect(DEFAULT_APPLICATION_FORM.questions.map((q) => q.key)).not.toContain(
      "trial",
    );
  });

  test("absent row (defaults) is untouched", async () => {
    const t = newT();
    expect(await run(t, runApplicationFormDropTrialQuestion)).toEqual({
      changed: 0,
    });
  });
});
