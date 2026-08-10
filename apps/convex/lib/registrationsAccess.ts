/**
 * Who can see a project's REGISTRATIONS — the named power behind
 * `registrations.ts#forProject`, written now rather than inlined at the call
 * site (CLAUDE.md: "gate it behind a power, even when it's open today").
 *
 * ── TODAY'S ANSWER ──────────────────────────────────────────────────────────
 * Whoever can already see the project's money. A registration is revenue with
 * a person's name and a scholarship decision attached, and it renders INSIDE
 * the money surface (`MoneyView`) whose own gate is
 * `moneyViews.ts#resolveRefAuthz`: finance `viewer` at the project's own
 * chapter, or central (org-wide) finance reach when reading another chapter's
 * project. This resolver is that same rule, said once, by name — so the
 * registrations section can never quietly become more visible than the budget
 * bar it sits under.
 *
 * A foreign-chapter caller without central reach gets `false` / a soft empty
 * rather than a throw, mirroring `resolveRefAuthz`'s deliberate choice: a
 * refusal that distinguishes "no permission" from "no such project" is an
 * existence oracle for every project id in the org.
 *
 * ── TOMORROW'S ──────────────────────────────────────────────────────────────
 * When registrations grow their own audience — a course administrator who
 * manages a cohort's roster without being finance staff — this graduates to a
 * `registrations.view` string in `SEAT_CAPABILITIES`
 * (`packages/shared/src/seats.ts`), listed on the seats that should carry it,
 * and ONLY the body below changes. No call site moves.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { financeRoleAtLeast } from "@events-os/shared";
import { getChapterIdOrNull } from "./context";
import { getFinanceRole } from "./finance";

/**
 * Can the caller see registrations for a project in `chapterId`? Soft — never
 * throws for a permission miss (see the header). Throws only when the caller
 * has no chapter at all, which is an account-setup problem, not an answer.
 */
export async function hasRegistrationView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const ownChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
  if (!ownChapterId) {
    throw new ConvexError({
      code: "NO_CHAPTER",
      message: "You don't belong to a chapter yet.",
    });
  }
  // Checked through the CALLER'S OWN chapter, never the target's — the same
  // direction `resolveRefAuthz` and `dashboardChapter` use, so a caller can't
  // acquire reach into a chapter by pointing at it.
  const access = await getFinanceRole(ctx, ownChapterId);
  if (chapterId !== ownChapterId) return access.isCentral;
  return access.isCentral || financeRoleAtLeast(access.role, "viewer");
}

/**
 * The throwing form, for any future WRITE path (a registration page settling a
 * checkout, a manual comp). Nothing calls it yet — it exists so the first
 * writer doesn't invent its own check, which is exactly how a gate goes
 * missing.
 */
export async function requireRegistrationView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  if (!(await hasRegistrationView(ctx, chapterId))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "This action needs finance access to this project's chapter.",
    });
  }
}
