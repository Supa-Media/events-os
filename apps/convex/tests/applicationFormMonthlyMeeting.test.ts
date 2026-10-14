/**
 * 0093: the stored form gains the yes/no `monthly_meeting` question right
 * after `capacity`, and nothing else the desk wrote changes.
 */
import { describe, expect, test } from "vitest";
import { DEFAULT_APPLICATION_FORM } from "@events-os/shared";
import { newT, run } from "./setup.helpers";
import { runApplicationFormMonthlyMeetingQuestion } from "../migrations/0093_application_form_monthly_meeting_question";

describe("0093_application_form_monthly_meeting_question", () => {
  test("inserts the question after capacity, once", async () => {
    const t = newT();
    const stored = DEFAULT_APPLICATION_FORM.questions
      .filter((q) => q.key !== "monthly_meeting")
      .map((q) => (q.key === "why" ? { ...q, label: "Desk wording" } : q));
    await run(t, async (ctx) => {
      await ctx.db.insert("applicationForm", {
        questions: stored,
        requiredFields: DEFAULT_APPLICATION_FORM.requiredFields,
        updatedAt: 1,
      });
    });
    expect(await run(t, runApplicationFormMonthlyMeetingQuestion)).toEqual({
      changed: 1,
    });
    const row = await run(t, (ctx) => ctx.db.query("applicationForm").first());
    const keys = row!.questions.map((q) => q.key);
    expect(keys.indexOf("monthly_meeting")).toBe(keys.indexOf("capacity") + 1);
    expect(row!.questions.find((q) => q.key === "monthly_meeting")).toMatchObject({
      required: true,
      kind: "yesNo",
      label: expect.stringContaining("first Thursday"),
    });
    expect(row!.questions[0].label).toBe("Desk wording");
    expect(await run(t, runApplicationFormMonthlyMeetingQuestion)).toEqual({
      changed: 0,
    });
  });

  test("absent row (defaults) is untouched", async () => {
    const t = newT();
    expect(await run(t, runApplicationFormMonthlyMeetingQuestion)).toEqual({
      changed: 0,
    });
  });
});
