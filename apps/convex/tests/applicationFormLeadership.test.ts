/**
 * 0091: the stored form's `escalation` question becomes `leadership`, in
 * place, and nothing else the desk wrote changes.
 */
import { describe, expect, test } from "vitest";
import { DEFAULT_APPLICATION_FORM } from "@events-os/shared";
import { newT, run } from "./setup.helpers";
import { runApplicationFormLeadershipQuestion } from "../migrations/0091_application_form_leadership_question";

const OLD_ESCALATION = {
  key: "escalation",
  label: "Describe a hard call you had to take to someone above you.",
  help: "What was the problem, what options did you weigh, and what did you recommend?",
  maxLength: 1800,
  required: false,
};

describe("0091_application_form_leadership_question", () => {
  test("rewrites escalation in its slot, keeping limit and required", async () => {
    const t = newT();
    const stored = DEFAULT_APPLICATION_FORM.questions.map((q) =>
      q.key === "leadership" ? OLD_ESCALATION : q,
    );
    await run(t, async (ctx) => {
      await ctx.db.insert("applicationForm", {
        questions: stored,
        requiredFields: DEFAULT_APPLICATION_FORM.requiredFields,
        updatedAt: 1,
      });
    });
    expect(await run(t, runApplicationFormLeadershipQuestion)).toEqual({
      changed: 1,
    });
    const row = await run(t, (ctx) => ctx.db.query("applicationForm").first());
    const i = stored.findIndex((q) => q.key === "escalation");
    expect(row!.questions[i]).toEqual({
      key: "leadership",
      label: "Tell us about a time you led people.",
      help: expect.stringContaining("same page"),
      maxLength: 1800,
      required: false,
    });
    expect(row!.questions.map((q) => q.key)).not.toContain("escalation");
    expect(await run(t, runApplicationFormLeadershipQuestion)).toEqual({
      changed: 0,
    });
  });

  test("absent row (defaults) is untouched", async () => {
    const t = newT();
    expect(await run(t, runApplicationFormLeadershipQuestion)).toEqual({
      changed: 0,
    });
  });
});
