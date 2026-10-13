/**
 * 0090: the stored application form's church question names Kingdom City,
 * not Fount, and nothing else the desk wrote changes.
 */
import { describe, expect, test } from "vitest";
import { DEFAULT_APPLICATION_FORM } from "@events-os/shared";
import { newT, run } from "./setup.helpers";
import {
  renameFount,
  runApplicationFormKingdomCity,
} from "../migrations/0090_application_form_kingdom_city";

describe("0090_application_form_kingdom_city", () => {
  test("renames Fount and Fount Church, leaves other text alone", () => {
    expect(renameFount("Are you part of a church like Fount?")).toBe(
      "Are you part of a church like Kingdom City?",
    );
    expect(renameFount("e.g. Fount Church in NYC")).toBe(
      "e.g. Kingdom City in NYC",
    );
    expect(renameFount("Fountain of life")).toBe("Fountain of life");
  });

  test("patches the stored row once, then is a no-op", async () => {
    const t = newT();
    await run(t, async (ctx) => {
      await ctx.db.insert("applicationForm", {
        questions: DEFAULT_APPLICATION_FORM.questions.map((q) =>
          q.key === "covering"
            ? { ...q, label: "Are you part of a church, like Fount?" }
            : q,
        ),
        requiredFields: DEFAULT_APPLICATION_FORM.requiredFields,
        updatedAt: 1,
      });
    });
    expect(await run(t, runApplicationFormKingdomCity)).toEqual({ changed: 1 });
    const row = await run(t, (ctx) => ctx.db.query("applicationForm").first());
    const covering = row!.questions.find((q) => q.key === "covering")!;
    expect(covering.label).toBe("Are you part of a church, like Kingdom City?");
    expect(row!.questions.filter((q) => q.key !== "covering")).toEqual(
      DEFAULT_APPLICATION_FORM.questions.filter((q) => q.key !== "covering"),
    );
    expect(await run(t, runApplicationFormKingdomCity)).toEqual({ changed: 0 });
  });

  test("absent row (defaults) is untouched", async () => {
    const t = newT();
    expect(await run(t, runApplicationFormKingdomCity)).toEqual({ changed: 0 });
  });
});
