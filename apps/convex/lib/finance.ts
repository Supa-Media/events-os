/**
 * Finance authorization for Chapter OS.
 *
 * The graded finance-role ladder (viewer < bookkeeper < manager) plus a
 * central/org tier, mirroring `lib/superuser.ts` + `lib/org.ts`. Every
 * finance function resolves the caller through `people` (the finance-actor
 * convention) and gates on their `financeRoles` grant.
 *
 *  - Superusers are implicitly CENTRAL managers (the bootstrap path — they seed
 *    the first grants). Everyone else needs an explicit `financeRoles` row; a
 *    chapter admin is NOT automatically a finance manager, which keeps
 *    separation of duties meaningful.
 *  - A `scope: "central"` grant layers org-wide roll-up reach on top of the
 *    chapter ladder.
 *  - Separation of duties (approver ≠ requester) is a pure assertion the
 *    reimbursement/payout flows call before recording an approval.
 *
 * All checks throw `ConvexError` (never a plain `Error`) so the app's
 * AuthErrorBoundary can surface them instead of dead-ending in the root
 * error boundary.
 */
import { ConvexError } from "convex/values";
import {
  FINANCE_ROLE_RANK,
  FINANCE_ROLE_LABELS,
  financeRoleAtLeast,
  type FinanceRole,
  type FinanceRoleScope,
} from "@events-os/shared";
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { isSuperuser } from "./superuser";
import { viewerPerson } from "./org";

/** The caller's resolved finance capability in a chapter. */
export interface FinanceAccess {
  /** The caller's roster person id, or null (superuser without a roster row). */
  personId: Id<"people"> | null;
  /** Their effective graded role, or null when ungranted. */
  role: FinanceRole | null;
  /** The scope of the winning grant (`central` outranks `chapter`). */
  scope: FinanceRoleScope | null;
  /** Convenience: `role === "manager"`. */
  isManager: boolean;
  /** They hold a central/org-wide grant (or are a superuser). */
  isCentral: boolean;
}

/**
 * The caller's roster person id in this chapter, or throw. Finance actors are
 * `people`, so most finance writes start here.
 */
export async function resolveCallerPersonId(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Id<"people">> {
  const person = await viewerPerson(ctx, chapterId);
  if (!person) {
    throw new ConvexError({
      code: "NO_PERSON",
      message: "You don't have a roster profile in this chapter yet.",
    });
  }
  return person._id;
}

/**
 * Resolve the caller's finance capability. Superusers short-circuit to central
 * manager; otherwise the effective role is the highest-ranked of their
 * chapter-scoped and central-scoped `financeRoles` grants.
 */
export async function getFinanceRole(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  if (await isSuperuser(ctx)) {
    const self = await viewerPerson(ctx, chapterId);
    return {
      personId: self?._id ?? null,
      role: "manager",
      scope: "central",
      isManager: true,
      isCentral: true,
    };
  }

  const person = await viewerPerson(ctx, chapterId);
  if (!person) {
    return {
      personId: null,
      role: null,
      scope: null,
      isManager: false,
      isCentral: false,
    };
  }

  const grants = await ctx.db
    .query("financeRoles")
    .withIndex("by_person", (q) => q.eq("personId", person._id))
    .collect();

  // Applicable grants = this chapter's grants + any central (org-wide) grant.
  // Effective role is the STRONGEST across all of them, not the first-created —
  // otherwise an apparent downgrade (a later, weaker re-grant) would silently
  // leave the earlier, stronger role in force. `grantFinanceRole` upserts, so in
  // practice there's one row per (chapter, person); this stays correct even if a
  // stray duplicate exists.
  const applicable = grants.filter(
    (g) => g.chapterId === chapterId || g.scope === "central",
  );
  const isCentral = applicable.some((g) => g.scope === "central");
  let role: FinanceRole | null = null;
  for (const g of applicable) {
    if (role == null || FINANCE_ROLE_RANK[g.role] > FINANCE_ROLE_RANK[role]) {
      role = g.role;
    }
  }

  return {
    personId: person._id,
    role,
    scope: isCentral ? "central" : role != null ? "chapter" : null,
    isManager: role === "manager",
    isCentral,
  };
}

/**
 * Assert the caller holds at least the `min` finance role, returning their
 * resolved access. The single gate every read/write function calls.
 */
export async function requireFinanceRole(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  min: FinanceRole,
): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, chapterId);
  if (!financeRoleAtLeast(access.role, min)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: `This action needs at least the ${FINANCE_ROLE_LABELS[min]} finance role.`,
    });
  }
  return access;
}

/** Assert the caller is a finance manager (the write/approve gate). */
export async function requireFinanceManager(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  return requireFinanceRole(ctx, chapterId, "manager");
}

/** Assert the caller has central/org-wide finance reach (the roll-up gate). */
export async function requireFinanceCentral(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, chapterId);
  if (!access.isCentral) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "This action needs central (org-wide) finance access.",
    });
  }
  return access;
}

/**
 * Separation of duties: the approver must be a different person than the
 * requester. Called by the reimbursement/payout approval flows before an
 * approval is recorded. Pure (no ctx) so it's trivially testable.
 */
export function assertSeparationOfDuties(
  approverPersonId: Id<"people">,
  requesterPersonId: Id<"people"> | null | undefined,
): void {
  if (requesterPersonId != null && approverPersonId === requesterPersonId) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message: "The approver must be different from the requester.",
    });
  }
}
