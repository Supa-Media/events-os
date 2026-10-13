/**
 * The live `/team/apply` form — read side.
 *
 * Every reader (the public form's feed, the submit gate, the desk) goes
 * through `loadApplicationForm`, so "nobody has edited it yet" and "somebody
 * saved it" look the same to callers: both are an `ApplicationFormConfig`.
 * The single `applicationForm` row only exists once the desk saves a change.
 */
import { v } from "convex/values";
import {
  DEFAULT_APPLICATION_FORM,
  type ApplicationFormConfig,
} from "@events-os/shared";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const applicationQuestionValidator = v.object({
  key: v.string(),
  label: v.string(),
  help: v.string(),
  maxLength: v.number(),
  required: v.boolean(),
});

export const requiredFieldsValidator = v.object({
  phone: v.boolean(),
  location: v.boolean(),
  gender: v.boolean(),
  socialHandle: v.boolean(),
  links: v.boolean(),
  referredBy: v.boolean(),
});

export const applicationFormValidator = v.object({
  questions: v.array(applicationQuestionValidator),
  requiredFields: requiredFieldsValidator,
});

/** The stored row, if the desk has ever saved one. */
export async function applicationFormRow(
  ctx: QueryCtx,
): Promise<Doc<"applicationForm"> | null> {
  return await ctx.db.query("applicationForm").first();
}

/** The form as applicants see it right now — the saved one, or the defaults. */
export async function loadApplicationForm(
  ctx: QueryCtx,
): Promise<ApplicationFormConfig> {
  const row = await applicationFormRow(ctx);
  if (!row) {
    return {
      questions: DEFAULT_APPLICATION_FORM.questions.map((q) => ({ ...q })),
      requiredFields: { ...DEFAULT_APPLICATION_FORM.requiredFields },
    };
  }
  return {
    questions: row.questions,
    // A row saved before a field existed takes that field's default.
    requiredFields: {
      ...DEFAULT_APPLICATION_FORM.requiredFields,
      ...row.requiredFields,
    },
  };
}
