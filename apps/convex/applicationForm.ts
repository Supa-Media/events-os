/**
 * THE APPLICATION FORM — the questions on `/team/apply`, edited from the OS.
 *
 * The questions used to be a constant in `@events-os/shared`, so rewording one
 * or making it optional meant a pull request. Now the desk edits them on the
 * People desk's "Application form" tab; the public page reads them live over
 * `GET /api/team/application` (`http.ts` → `publicApplicationForm`), and
 * `hiring.submitApplication` validates against the same live set.
 *
 * Questions keep a stable `key` across edits. Rewording one keeps its answers;
 * deleting one leaves old answers readable because every file snapshots the
 * labels it was asked (`jobApplications.questions`).
 */
import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { problemsWithApplicationForm } from "@events-os/shared";
import {
  requireApplicationFormManage,
  requireHiringView,
} from "./lib/hiringAccess";
import { requireUserId } from "./lib/context";
import {
  applicationFormRow,
  applicationFormValidator,
  loadApplicationForm,
} from "./lib/applicationForm";
import type { Id } from "./_generated/dataModel";

/** The desk's view: the live form, and whether it's still the defaults. */
export const getApplicationForm = query({
  args: {},
  returns: v.object({
    form: applicationFormValidator,
    isDefault: v.boolean(),
    updatedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    await requireHiringView(ctx);
    const row = await applicationFormRow(ctx);
    return {
      form: await loadApplicationForm(ctx),
      isDefault: row === null,
      updatedAt: row?.updatedAt ?? null,
    };
  },
});

/** Replace the form. Takes effect on the public page immediately. */
export const saveApplicationForm = mutation({
  args: { form: applicationFormValidator },
  returns: v.null(),
  handler: async (ctx, { form }) => {
    await requireApplicationFormManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const cleaned = {
      questions: form.questions.map((q) => ({
        key: q.key.trim(),
        label: q.label.trim(),
        help: q.help.trim(),
        maxLength: q.maxLength,
        required: q.required,
      })),
      requiredFields: form.requiredFields,
    };
    const problems = problemsWithApplicationForm(cleaned);
    if (problems.length > 0) {
      throw new ConvexError({
        code: "INVALID_APPLICATION_FORM",
        message: problems.join(" "),
      });
    }

    const row = await applicationFormRow(ctx);
    const now = Date.now();
    if (row) {
      await ctx.db.patch(row._id, { ...cleaned, updatedAt: now, updatedBy: userId });
    } else {
      await ctx.db.insert("applicationForm", {
        ...cleaned,
        updatedAt: now,
        updatedBy: userId,
      });
    }
    return null;
  },
});

/** Throw away every edit and go back to the questions the org first wrote. */
export const resetApplicationForm = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireApplicationFormManage(ctx);
    const row = await applicationFormRow(ctx);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/** The public feed behind `GET /api/team/application`. No PII — it's the
 *  form's own copy, which the page shows to anyone anyway. */
export const publicApplicationForm = internalQuery({
  args: {},
  returns: applicationFormValidator,
  handler: async (ctx) => await loadApplicationForm(ctx),
});
