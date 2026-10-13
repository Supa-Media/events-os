import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Point the application form's church question at Kingdom City (2026-10-13).
 *
 * The live `/team/apply` form had been edited in the OS to name Fount; the
 * founder asked for Kingdom City (https://kingdomcity.com) instead. The code
 * default (`DEFAULT_APPLICATION_QUESTIONS`) names no church, so only the
 * stored row carries the old name. Rewrites "Fount" (and "Fount Church") in
 * every question's label and help; every other word stays as the desk wrote
 * it. Answers are keyed by question `key`, which is untouched.
 *
 * Idempotent by content: a second run finds no "Fount" left.
 */
const FOUNT = /\bFount(?:\s+Church)?\b/gi;

export function renameFount(text: string): string {
  return text.replace(FOUNT, "Kingdom City");
}

export async function runApplicationFormKingdomCity(ctx: MutationCtx) {
  const row = await ctx.db.query("applicationForm").first();
  if (!row) return { changed: 0 };
  let changed = 0;
  const questions = row.questions.map((q) => {
    const label = renameFount(q.label);
    const help = renameFount(q.help);
    if (label !== q.label || help !== q.help) changed++;
    return { ...q, label, help };
  });
  if (changed > 0) {
    await ctx.db.patch(row._id, { questions, updatedAt: Date.now() });
  }
  return { changed };
}

export const applicationFormKingdomCity: Migration = {
  name: "0090_application_form_kingdom_city",
  run: runApplicationFormKingdomCity,
};
